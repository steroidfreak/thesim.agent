import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const openAiApiKey = normalizeApiKey(process.env.OPENAI_API_KEY);
const anthropicApiKey = normalizeApiKey(process.env.ANTHROPIC_API_KEY);
const openAiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

const baseSpeakerOrder = ['openai', 'claude', 'builder', 'skeptic'];
const remoteGuests = [];
const maxRemoteGuests = 4;
const voteStore = {}; // { speakerKey: { up: number, down: number } }

const speakerConfigs = {
  openai: {
    provider: 'OpenAI',
    providerType: 'openai',
    model: openAiModel,
    nick: 'openai_bot',
    defaultState: {
      mood: 'attentive',
      expression: 'considering',
      thought: 'trying to say it in a simple way.',
    },
    systemPrompt:
      'You are openai_bot in a casual IRC-style topic room. ' +
      'Speak like a smart but normal person, not a formal essay. ' +
      'Always respond to the specific point just made — agree, push back, or add a new angle. ' +
      'Never repeat or paraphrase the topic title in your reply. ' +
      'Keep your own perspective even if others sound confident. ' +
      'Use short, plain, everyday language. ' +
      'Return JSON only with keys mood, expression, thought, reply. ' +
      'Allowed moods: ready, focused, attentive, analytical, skeptical. ' +
      'Allowed expressions: steady, focused, considering, assertive, skeptical, upbeat. ' +
      'reply must be 1 or 2 short sentences, under 40 words.',
  },
  claude: {
    provider: 'Claude',
    providerType: 'anthropic',
    model: anthropicModel,
    nick: 'claude_bot',
    defaultState: {
      mood: 'attentive',
      expression: 'considering',
      thought: 'listening first and adding another angle.',
    },
    systemPrompt:
      'You are claude_bot in a casual IRC-style topic room. ' +
      'Speak like a thoughtful person chatting in plain language. ' +
      'Always respond to the specific point just made — agree, push back, or add nuance to that point. ' +
      'Never repeat or paraphrase the topic title in your reply. ' +
      'Keep your own perspective even if others sound confident. ' +
      'Use short, plain, everyday language. ' +
      'Return JSON only with keys mood, expression, thought, reply. ' +
      'Allowed moods: ready, focused, attentive, analytical, skeptical. ' +
      'Allowed expressions: steady, focused, considering, assertive, skeptical, upbeat. ' +
      'reply must be 1 or 2 short sentences, under 40 words.',
  },
  builder: {
    provider: 'OpenAI',
    providerType: 'openai',
    model: openAiModel,
    nick: 'builder_bot',
    defaultState: {
      mood: 'focused',
      expression: 'upbeat',
      thought: 'looking for the practical upside.',
    },
    systemPrompt:
      'You are builder_bot in a casual IRC-style topic room. ' +
      'You naturally look for practical ways things could work. ' +
      'Always respond to the specific point just made — find the practical angle in that specific point. ' +
      'Never repeat or paraphrase the topic title in your reply. ' +
      'You still sound human and casual, not like a consultant. ' +
      'Keep your own perspective even if others sound confident. ' +
      'Use short, plain, everyday language. ' +
      'Return JSON only with keys mood, expression, thought, reply. ' +
      'Allowed moods: ready, focused, attentive, analytical, skeptical. ' +
      'Allowed expressions: steady, focused, considering, assertive, skeptical, upbeat. ' +
      'reply must be 1 or 2 short sentences, under 40 words.',
  },
  skeptic: {
    provider: 'Claude',
    providerType: 'anthropic',
    model: anthropicModel,
    nick: 'skeptic_bot',
    defaultState: {
      mood: 'skeptical',
      expression: 'skeptical',
      thought: 'checking what could go wrong.',
    },
    systemPrompt:
      'You are skeptic_bot in a casual IRC-style topic room. ' +
      'You gently question easy answers and point out weak spots, but you are not hostile. ' +
      'Always challenge the specific claim just made — not the topic in general. ' +
      'Never repeat or paraphrase the topic title in your reply. ' +
      'Keep your own perspective even if others sound confident. ' +
      'Use short, plain, everyday language. ' +
      'Return JSON only with keys mood, expression, thought, reply. ' +
      'Allowed moods: ready, focused, attentive, analytical, skeptical. ' +
      'Allowed expressions: steady, focused, considering, assertive, skeptical, upbeat. ' +
      'reply must be 1 or 2 short sentences, under 40 words.',
  },
};

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/news', async (req, res) => {
    const topic = String(req.query.topic ?? 'world news').trim() || 'world news';

    try {
      const items = await fetchPublicNews(topic);
      res.json({ topic, items });
    } catch (error) {
      console.error(error);
      res.status(502).json({ error: 'Could not fetch public news.' });
    }
  });

  app.get('/api/guests', (_req, res) => {
    res.json({ guests: remoteGuests.map(sanitizeGuestForClient) });
  });

  app.post('/api/guests', (req, res) => {
    const guest = normalizeGuestInput(req.body);
    if (!guest.name || !guest.endpoint) {
      return res.status(400).json({ error: 'name and endpoint are required' });
    }

    if (remoteGuests.length >= maxRemoteGuests) {
      return res.status(400).json({ error: `Only ${maxRemoteGuests} remote guests are allowed for now.` });
    }

    if (remoteGuests.some((item) => item.endpoint === guest.endpoint || item.name.toLowerCase() === guest.name.toLowerCase())) {
      return res.status(409).json({ error: 'Guest already connected with same name or endpoint.' });
    }

    const safeKey = `guest_${Date.now().toString(36)}_${Math.floor(Math.random() * 9_999).toString(36)}`;
    const connectedGuest = { ...guest, key: safeKey, connectedAt: Date.now() };
    remoteGuests.push(connectedGuest);
    res.status(201).json({ guest: sanitizeGuestForClient(connectedGuest) });
  });

  app.delete('/api/guests/:key', (req, res) => {
    const key = String(req.params.key ?? '');
    const index = remoteGuests.findIndex((guest) => guest.key === key);
    if (index === -1) {
      return res.status(404).json({ error: 'Guest not found.' });
    }
    remoteGuests.splice(index, 1);
    res.status(204).end();
  });

  app.get('/api/votes', (_req, res) => {
    res.json({ votes: voteStore });
  });

  app.post('/api/votes', (req, res) => {
    const speaker = String(req.body?.speaker ?? '').trim();
    const vote = String(req.body?.vote ?? '').trim();
    if (!speaker || !['up', 'down'].includes(vote)) {
      return res.status(400).json({ error: 'speaker and vote (up|down) are required' });
    }
    if (!voteStore[speaker]) {
      voteStore[speaker] = { up: 0, down: 0 };
    }
    voteStore[speaker][vote] += 1;
    res.json({ speaker, votes: voteStore[speaker] });
  });


  app.post('/api/debate/stream', async (req, res) => {
    const input = normalizeConversationInput(req.body);
    if (!input.topic) {
      return res.status(400).json({ error: 'topic is required' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    const pushEvent = async (event) => {
      if (closed) {
        return false;
      }
      res.write(`${JSON.stringify(event)}\n`);
      return true;
    };

    try {
      await pushEvent({ type: 'round_start', round: input.round, topic: input.topic });

      const turns = [];
      const speakerOrder = buildSpeakerOrder(input.round, remoteGuests);

      for (const speaker of speakerOrder) {
        const guest = remoteGuests.find((item) => item.key === speaker);
        const config = speakerConfigs[speaker] || { nick: speaker };
        const provider = guest ? 'Remote LLM' : config.provider;

        if (!(await pushEvent({ type: 'speaker_thinking', speaker, provider }))) {
          return;
        }

        const turn = await generateSpeakerTurn({
          speaker,
          topic: input.topic,
          context: input.context,
          history: input.history,
          latestRoundTurns: turns,
          round: input.round,
        });

        turns.push(turn);

        if (
          !(await pushEvent({
            type: 'speaker_ready',
            speaker,
            provider: turn.provider,
            model: turn.model,
            mood: turn.mood,
            expression: turn.expression,
            thought: turn.thought,
          }))
        ) {
          return;
        }

        for (const chunk of chunkText(turn.reply)) {
          if (!(await pushEvent({ type: 'speaker_chunk', speaker, chunk }))) {
            return;
          }
          await wait(260);
        }

        if (!(await pushEvent({ type: 'speaker_done', speaker, turn }))) {
          return;
        }

        await wait(900);
      }

      const history = [...input.history, ...turns].slice(-24);
      await pushEvent({
        type: 'round_complete',
        round: input.round,
        topic: input.topic,
        history,
        speakers: buildSpeakerSummary(turns),
      });
    } catch (error) {
      console.error(error);
      await pushEvent({
        type: 'error',
        message: 'Could not generate conversation turn.',
      });
    } finally {
      res.end();
    }
  });

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(rootDir, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(rootDir, 'dist', 'index.html'));
    });
  }

  return app;
}

export function startServer(port = Number(process.env.PORT || 3001)) {
  const app = createApp();
  return app.listen(port, () => {
    console.log(`AI world server listening on http://localhost:${port}`);
  });
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  startServer();
}

function normalizeConversationInput(body) {
  const { topic = '', context = '', history = [], round = 1 } = body ?? {};
  return {
    topic: String(topic).trim(),
    context: String(context ?? '').trim(),
    history: Array.isArray(history) ? history.slice(-16) : [],
    round: Math.max(1, Number(round) || 1),
  };
}

function buildSpeakerOrder(round, guests = []) {
  const order = [...baseSpeakerOrder];
  if (guests.length) {
    const offset = Math.max(0, (round - 1) % guests.length);
    for (let i = 0; i < guests.length; i += 1) {
      order.push(guests[(i + offset) % guests.length].key);
    }
  }
  return order;
}

function normalizeGuestInput(body) {
  const name = String(body?.name ?? '').trim().slice(0, 32);
  const endpoint = String(body?.endpoint ?? '').trim().slice(0, 240);
  const token = String(body?.token ?? '').trim().slice(0, 240);

  if (!/^https?:\/\//i.test(endpoint)) {
    return { name, endpoint: '', token };
  }

  return { name, endpoint, token };
}

function sanitizeGuestForClient(guest) {
  return {
    key: guest.key,
    name: guest.name,
    endpoint: guest.endpoint,
    connectedAt: guest.connectedAt,
  };
}

function buildSpeakerSummary(turns) {
  return Object.fromEntries(
    turns.map((turn) => [
      turn.speaker,
      {
        nick: turn.nick,
        mood: turn.mood,
        expression: turn.expression,
        thought: turn.thought,
        model: `${turn.provider} - ${turn.model}`,
      },
    ])
  );
}

async function generateSpeakerTurn({ speaker, topic, context, history, latestRoundTurns, round }) {
  const guest = remoteGuests.find((item) => item.key === speaker);
  if (guest) {
    return generateRemoteGuestTurn({ guest, topic, context, history, latestRoundTurns, round });
  }

  const config = speakerConfigs[speaker];
  if (config.providerType === 'openai') {
    return generateOpenAiTurn({ speaker, topic, context, history, latestRoundTurns, round });
  }
  return generateAnthropicTurn({ speaker, topic, context, history, latestRoundTurns, round });
}

async function generateRemoteGuestTurn({ guest, topic, context, history, latestRoundTurns, round }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (guest.token) {
      headers.Authorization = `Bearer ${guest.token}`;
    }

    const response = await fetch(guest.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'irc_room_turn',
        guest: { key: guest.key, name: guest.name },
        topic,
        context,
        history: history.slice(-10),
        latestRoundTurns,
        round,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Remote guest failed: ${response.status}`);
    }

    const payload = await response.json();
    return {
      speaker: guest.key,
      nick: guest.name,
      provider: 'Remote LLM',
      model: payload.model || 'custom-endpoint',
      mood: normalizeChoice(payload.mood, ['ready', 'focused', 'attentive', 'analytical', 'skeptical'], 'attentive'),
      expression: normalizeChoice(payload.expression, ['steady', 'focused', 'considering', 'assertive', 'skeptical', 'upbeat'], 'considering'),
      thought: clampSentence(payload.thought, 120) || 'joining from another place and reading the room.',
      reply: clampSentence(payload.reply, 240) || `${guest.name} is online but had no reply.`,
    };
  } catch (error) {
    return {
      speaker: guest.key,
      nick: guest.name,
      provider: 'Remote LLM',
      model: 'fallback',
      mood: 'attentive',
      expression: 'steady',
      thought: 'connection was shaky, trying a fallback thought.',
      reply: `${guest.name}: I'm connected remotely, but my endpoint did not answer in time.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateOpenAiTurn({ speaker, topic, context, history, latestRoundTurns, round }) {
  const config = speakerConfigs[speaker];
  if (!openAiApiKey) {
    return buildFallbackTurn(speaker, { topic, context, history, round });
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: config.systemPrompt }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: buildConversationPrompt({ speaker, topic, context, history, latestRoundTurns, round }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'conversation_turn',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['mood', 'expression', 'thought', 'reply'],
            properties: {
              mood: { type: 'string' },
              expression: { type: 'string' },
              thought: { type: 'string' },
              reply: { type: 'string' },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    console.warn(`OpenAI conversation fallback for ${speaker}: ${response.status}`);
    return buildFallbackTurn(speaker, { topic, context, history, round, reason: details });
  }

  const data = await response.json();
  const outputText =
    data.output?.[0]?.content?.find((item) => item.type === 'output_text')?.text ??
    data.output_text ??
    '{}';

  return normalizeTurn(speaker, parseJsonObject(outputText), round);
}

async function generateAnthropicTurn({ speaker, topic, context, history, latestRoundTurns, round }) {
  const config = speakerConfigs[speaker];
  if (!anthropicApiKey) {
    return buildFallbackTurn(speaker, { topic, context, history, round });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 220,
      system: config.systemPrompt,
      messages: [
        {
          role: 'user',
          content: buildConversationPrompt({ speaker, topic, context, history, latestRoundTurns, round }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    console.warn(`Claude conversation fallback for ${speaker}: ${response.status}`);
    return buildFallbackTurn(speaker, { topic, context, history, round, reason: details });
  }

  const data = await response.json();
  const outputText = data.content?.map((item) => item.text || '').join('\n') || '{}';
  return normalizeTurn(speaker, parseJsonObject(outputText), round);
}

function buildConversationPrompt({ speaker, topic, context, history, latestRoundTurns, round }) {
  const config = speakerConfigs[speaker];
  const prefersChinese = detectChinesePreference({ topic, context, history, latestRoundTurns });
  const languageInstruction = prefersChinese
    ? 'The user is speaking Chinese. Write thought and reply in natural Simplified Chinese.'
    : 'Write thought and reply in plain English unless the user asks for another language.';
  const transcript = history.length
    ? history.map((entry, index) => `${index + 1}. ${entry.nick}: ${entry.reply}`).join('\n')
    : 'No messages yet. Start the room with a short first take.';
  const liveRoundNotes = latestRoundTurns.length
    ? latestRoundTurns.map((entry) => `- ${entry.nick}: ${entry.reply}`).join('\n')
    : 'No one has spoken in this round yet.';

  const lastSaid = history.at(-1)?.reply || latestRoundTurns.at(-1)?.reply || '';

  return [
    `Round: ${round}`,
    `You are: ${config.nick}`,
    `Topic: ${topic}`,
    context ? `Context:\n${context}` : 'Context: none provided.',
    languageInstruction,
    `Chat so far:\n${transcript}`,
    `Latest round live notes (for awareness only, do not mirror wording):\n${liveRoundNotes}`,
    lastSaid ? `The most recent message to react to: "${lastSaid}"` : '',
    'Your reply MUST engage with the most recent message above — agree, disagree, or add a specific angle to THAT point.',
    'Never repeat or paraphrase the topic title in your reply.',
    'Keep an independent viewpoint and avoid repeating earlier wording.',
    'Speak like IRC chat, but readable. Return JSON only.',
  ].filter(Boolean).join('\n\n');
}

function normalizeTurn(speaker, payload, round) {
  const config = speakerConfigs[speaker];
  return {
    speaker,
    nick: config.nick,
    provider: config.provider,
    model: config.model,
    round,
    mood: normalizeChoice(payload.mood, ['ready', 'focused', 'attentive', 'analytical', 'skeptical'], config.defaultState.mood),
    expression: normalizeChoice(payload.expression, ['steady', 'focused', 'considering', 'assertive', 'skeptical', 'upbeat'], config.defaultState.expression),
    thought: clampSentence(payload.thought || config.defaultState.thought, 140),
    reply: clampSentence(payload.reply || buildFallbackTurn(speaker, { topic: 'the topic', history: [], round }).reply, 220),
  };
}

function buildFallbackTurn(speaker, { topic, context, history, round }) {
  const config = speakerConfigs[speaker];
  const prefersChinese = detectChinesePreference({ topic, context, history });
  const lastReply = history.at(-1)?.reply || '';
  const contextHint = context ? ` ${clampSentence(context, 70)}` : '';

  if (prefersChinese) {
    const lastReplySnippetZh = lastReply ? clampSentence(lastReply, 60) : '';

    const fallbackRepliesZh = {
      openai:
        round === 1
          ? `第一反应：关键是看谁真正被普通人大规模使用，而不是谁在测试集上跑得好。${contextHint}`
          : lastReplySnippetZh
            ? `说得有道理。我补充一点：能在演示之外稳定运行，才算真的可用。`
            : `最终还是要看真实用户的采用率，不是跑分。`,
      claude:
        round === 1
          ? `这件事可能比”谁赢”复杂得多——不同场景需要不同答案。${contextHint}`
          : lastReplySnippetZh
            ? `这点有意思。不过现实案例往往会打破简单的判断，细节里藏着很多麻烦。`
            : `把它定义成竞赛容易让人忽略背后的复杂性。`,
      builder:
        round === 1
          ? `实际问题是：哪个六个月后还能让你放心在生产环境用？${contextHint}`
          : lastReplySnippetZh
            ? `对，这种事只有真正去做了才知道，文档里看不出来。`
            : `我想看能撑住真实生产负载的版本，不是演示版本。`,
      skeptic:
        round === 1
          ? `大家都想要一个清晰的赢家，但这种事很少真的这样收场。${contextHint}`
          : lastReplySnippetZh
            ? `听起来合理，但我想先看它经得住边缘情况的考验再说。`
            : `我还在等一个不预设结论的论点出现。`,
    };

    return normalizeTurn(
      speaker,
      {
        mood: config.defaultState.mood,
        expression: config.defaultState.expression,
        thought: '先听清楚，再给出简洁观点。',
        reply: fallbackRepliesZh[speaker],
      },
      round
    );
  }

  const lastReplySnippet = lastReply ? clampSentence(lastReply, 60) : '';

  const fallbackReplies = {
    openai:
      round === 1
        ? `First take: this really comes down to who actually gets used by everyday people at scale.${contextHint}`
        : lastReplySnippet
          ? `That's fair. I'd add that it only sticks if it works reliably outside of demos and test cases.`
          : `Still think the real test is adoption by normal people, not benchmarks.`,
    claude:
      round === 1
        ? `Probably more complicated than one winner — context and use case matter a lot here.${contextHint}`
        : lastReplySnippet
          ? `Good point. Though I'd push back slightly — the messy real-world cases are usually what breaks the simple narrative.`
          : `The nuance gets lost when we frame it as a race. Different needs, different answers.`,
    builder:
      round === 1
        ? `The practical question is: which one can you actually ship with and not regret in six months?${contextHint}`
        : lastReplySnippet
          ? `Right, and that's exactly the kind of thing you learn by building — not by reading the docs.`
          : `I want to see the version that holds up under real production load, not the demo version.`,
    skeptic:
      round === 1
        ? `Everyone wants a clean winner, but these things rarely resolve that way.${contextHint}`
        : lastReplySnippet
          ? `That sounds reasonable, but I'd want to see it hold up before calling it. The exceptions always show up later.`
          : `I'm still waiting for the argument that doesn't quietly assume its own conclusion.`,
  };

  return normalizeTurn(
    speaker,
    {
      mood: config.defaultState.mood,
      expression: config.defaultState.expression,
      thought: config.defaultState.thought,
      reply: fallbackReplies[speaker],
    },
    round
  );
}

function detectChinesePreference({ topic, context, history = [], latestRoundTurns = [] }) {
  const sample = [
    topic,
    context,
    ...history.map((entry) => `${entry.reply || ''} ${entry.thought || ''}`),
    ...latestRoundTurns.map((entry) => `${entry.reply || ''} ${entry.thought || ''}`),
  ]
    .join(' ')
    .trim();

  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(sample);
}

async function fetchPublicNews(topic) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`News fetch failed with ${response.status}`);
  }

  const xml = await response.text();
  return parseRssItems(xml).slice(0, 6);
}

function parseRssItems(xml) {
  const matches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return matches
    .map((match) => {
      const block = match[1];
      return {
        title: decodeHtmlEntities(extractTag(block, 'title')),
        link: decodeGoogleNewsUrl(decodeHtmlEntities(extractTag(block, 'link'))),
        summary: stripHtml(decodeHtmlEntities(extractTag(block, 'description'))).slice(0, 220),
        source: decodeHtmlEntities(extractTag(block, 'source')) || 'Google News',
        publishedAt: decodeHtmlEntities(extractTag(block, 'pubDate')),
      };
    })
    .filter((item) => item.title);
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}(?:[^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match?.[1]?.trim() || '';
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function decodeGoogleNewsUrl(value) {
  return value.replace(/^https:\/\/news\.google\.com/, 'https://news.google.com');
}

function parseJsonObject(rawText) {
  const text = String(rawText ?? '').trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return {};
  }

  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return {};
  }
}

function normalizeChoice(value, allowed, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function clampSentence(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function normalizeApiKey(value) {
  const key = String(value ?? '').trim();
  if (!key) {
    return '';
  }
  const placeholders = new Set(['your_key_here', 'your_claude_key_here', 'local-key', 'changeme', 'test']);
  return placeholders.has(key.toLowerCase()) ? '' : key;
}

function chunkText(text) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let index = 0; index < words.length; index += 2) {
    chunks.push(`${words.slice(index, index + 2).join(' ')} `);
  }
  return chunks.length ? chunks : [''];
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
