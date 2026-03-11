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
      'Sometimes agree, sometimes disagree, sometimes just add a useful angle. ' +
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
      'Sometimes agree, sometimes disagree, sometimes soften the room with nuance. ' +
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
      const speakerOrder = buildSpeakerOrder(input.round);

      for (const speaker of speakerOrder) {
        const config = speakerConfigs[speaker];

        if (!(await pushEvent({ type: 'speaker_thinking', speaker, provider: config.provider }))) {
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
  const config = speakerConfigs[speaker];
  if (config.providerType === 'openai') {
    return generateOpenAiTurn({ speaker, topic, context, history, latestRoundTurns, round });
  }
  return generateAnthropicTurn({ speaker, topic, context, history, latestRoundTurns, round });
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

  return [
    `Round: ${round}`,
    `You are: ${config.nick}`,
    `Topic: ${topic}`,
    context ? `Context:\n${context}` : 'Context: none provided.',
    languageInstruction,
    `Chat so far:\n${transcript}`,
    `Latest round live notes (for awareness only, do not mirror wording):\n${liveRoundNotes}`,
    'Keep an independent viewpoint and avoid repeating earlier wording.',
    'Speak like IRC chat, but readable. Return JSON only.',
  ].join('\n\n');
}

function buildSpeakerOrder(round) {
  const offset = Math.max(0, (Number(round) || 1) - 1) % baseSpeakerOrder.length;
  return [...baseSpeakerOrder.slice(offset), ...baseSpeakerOrder.slice(0, offset)];
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
    const fallbackRepliesZh = {
      openai:
        round === 1
          ? `我对“${topic}”的第一反应是：要看它是否真的能帮到普通人。${contextHint}`
          : `我理解这个观点。谈到“${topic}”，我还是觉得要看它在日常生活里是否可行。${lastReply ? ` 上一条提到“${clampSentence(lastReply, 36)}”也很关键。` : ''}`,
      claude:
        round === 1
          ? `我部分同意，不过“${topic}”一旦放到真实场景里通常会更复杂。${contextHint}`
          : `这个点很有道理，但“${topic}”还是很依赖信任和习惯。${lastReply ? ` 我特别在意上一条说的“${clampSentence(lastReply, 34)}”。` : ''}`,
      builder:
        round === 1
          ? `我更关心“${topic}”怎样才能真正落地，而不只是听起来不错。${contextHint}`
          : `如果认真推进“${topic}”，我想先看到可以执行的版本。${lastReply ? ` 刚才关于“${clampSentence(lastReply, 34)}”这点很可操作。` : ''}`,
      skeptic:
        round === 1
          ? `也许吧，但我觉得像“${topic}”这类事，很多人下结论太快了。${contextHint}`
          : `我对“${topic}”还是保留意见。${lastReply ? ` 上一条关于“${clampSentence(lastReply, 34)}”听起来不错，但我还是想继续压测。` : ''}`,
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

  const fallbackReplies = {
    openai:
      round === 1
        ? `My quick take on "${topic}" is that it should be judged by whether it really helps normal people.${contextHint}`
        : `Yeah, I get that. For "${topic}", I still think the real test is whether it works in everyday life.${lastReply ? ` The last point about "${clampSentence(lastReply, 36)}" matters too.` : ''}`,
    claude:
      round === 1
        ? `I kind of agree, but "${topic}" feels more complicated once real people are involved.${contextHint}`
        : `Fair point, but "${topic}" still depends a lot on trust and habits.${lastReply ? ` What stayed with me was "${clampSentence(lastReply, 34)}".` : ''}`,
    builder:
      round === 1
        ? `I keep asking what would make "${topic}" actually usable, not just interesting on paper.${contextHint}`
        : `If we are serious about "${topic}", I want to know what the practical version looks like.${lastReply ? ` The part about "${clampSentence(lastReply, 34)}" feels actionable.` : ''}`,
    skeptic:
      round === 1
        ? `Maybe, but I think people rush topics like "${topic}" before the rough edges are clear.${contextHint}`
        : `I am still not fully sold on "${topic}".${lastReply ? ` The last message about "${clampSentence(lastReply, 34)}" sounds good, but I would still pressure-test it.` : ''}`,
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
