import * as THREE from 'three';
import './style.css';

const AGENTS = [
  {
    key: 'openai',
    name: 'openai_bot',
    label: 'OAI',
    x: -5.4,
    bodyColor: '#0c7c59',
    headColor: '#d8fff4',
    auraColor: '#5fe3b1',
    accent: '#49d39d',
    bubbleBackground: 'rgba(217, 255, 243, 0.97)',
    podiumColor: '#12261f',
  },
  {
    key: 'builder',
    name: 'builder_bot',
    label: 'BLD',
    x: -1.8,
    bodyColor: '#3256c9',
    headColor: '#dfe8ff',
    auraColor: '#81a7ff',
    accent: '#7d9fff',
    bubbleBackground: 'rgba(230, 238, 255, 0.97)',
    podiumColor: '#182548',
  },
  {
    key: 'claude',
    name: 'claude_bot',
    label: 'CLD',
    x: 1.8,
    bodyColor: '#a54818',
    headColor: '#ffe0c9',
    auraColor: '#ffad7a',
    accent: '#ef925b',
    bubbleBackground: 'rgba(255, 239, 226, 0.97)',
    podiumColor: '#3b1a0f',
  },
  {
    key: 'skeptic',
    name: 'skeptic_bot',
    label: 'SKP',
    x: 5.4,
    bodyColor: '#5f2b8a',
    headColor: '#f1dcff',
    auraColor: '#d39bff',
    accent: '#c88bff',
    bubbleBackground: 'rgba(246, 234, 255, 0.97)',
    podiumColor: '#261237',
  },
];

const canvas = document.querySelector('#scene');
const topicForm = document.querySelector('#topic-form');
const topicInput = document.querySelector('#topic-input');
const contextInput = document.querySelector('#context-input');
const startButton = document.querySelector('#start-debate');
const stopButton = document.querySelector('#stop-debate');
const nextTurnButton = document.querySelector('#next-round');
const newsButton = document.querySelector('#fetch-news');
const newsTopicInput = document.querySelector('#news-topic');
const newsList = document.querySelector('#news-list');
const transcriptEl = document.querySelector('#transcript');
const statusEl = document.querySelector('#status-text');
const currentTopicEl = document.querySelector('#current-topic');

const speakerElements = Object.fromEntries(
  AGENTS.map((agent) => [
    agent.key,
    {
      name: agent.name,
      mood: document.querySelector(`#${agent.key}-mood`),
      expression: document.querySelector(`#${agent.key}-expression`),
      thought: document.querySelector(`#${agent.key}-thought`),
      model: document.querySelector(`#${agent.key}-model`),
    },
  ])
);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#cdd8ed');
scene.fog = new THREE.Fog('#cdd8ed', 16, 38);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 9.6, 15.2);
camera.lookAt(0, 1.8, 0);

const clock = new THREE.Clock();
const roomState = {
  topic: '',
  context: '',
  history: [],
  round: 0,
  selectedNews: null,
  isRunning: false,
  autoLoop: false,
  streamController: null,
  streamingReplies: Object.fromEntries(AGENTS.map((agent) => [agent.key, ''])),
};

const avatars = Object.fromEntries(AGENTS.map((agent) => [agent.key, createAgent(agent)]));
for (const avatar of Object.values(avatars)) {
  scene.add(avatar.group);
}

addLights();
addSet();
seedTranscript();
syncSpeakerPanels();

window.addEventListener('resize', onResize);
topicForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startLoop();
});
stopButton.addEventListener('click', stopLoop);
nextTurnButton.addEventListener('click', () => runConversationTurn({ reset: false, autoLoop: false }));
newsButton.addEventListener('click', fetchNews);

function startLoop() {
  roomState.autoLoop = true;
  runConversationTurn({ reset: true, autoLoop: true });
}

function stopLoop() {
  roomState.autoLoop = false;
  stopButton.disabled = true;
  roomState.streamController?.abort();
  roomState.streamController = null;
  setStatus(`IRC room stopped after cycle ${roomState.round}.`);
}

async function runConversationTurn({ reset, autoLoop }) {
  if (roomState.isRunning) {
    return;
  }

  const topic = topicInput.value.trim();
  if (!topic) {
    setStatus('Set a topic before starting the room.');
    return;
  }

  roomState.autoLoop = autoLoop;

  if (reset) {
    roomState.history = [];
    roomState.round = 0;
    transcriptEl.innerHTML = '';
    for (const agent of AGENTS) {
      roomState.streamingReplies[agent.key] = '';
      hideSpeechBubble(agent.key);
      clearThinkingBubble(agent.key);
    }
    addTranscriptEntry('topic_bot', `Topic set: ${topic}`, 'system');
  }

  roomState.topic = topic;
  roomState.context = buildContextText();
  roomState.isRunning = true;
  startButton.disabled = true;
  stopButton.disabled = false;
  nextTurnButton.disabled = true;
  newsButton.disabled = true;
  currentTopicEl.textContent = topic;
  setStatus(
    reset
      ? 'Starting the IRC room.'
      : `Running another chat cycle on "${topic}".`
  );

  for (const agent of AGENTS) {
    setSpeakerState(agent.key, {
      mood: 'attentive',
      expression: 'considering',
      thought: 'getting ready to jump in.',
    });
  }

  const controller = new AbortController();
  roomState.streamController = controller;

  try {
    await streamConversationTurn({
      topic,
      context: roomState.context,
      history: roomState.history,
      round: roomState.round + 1,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      setStatus('The IRC room could not continue right now.');
    }
    roomState.autoLoop = false;
  } finally {
    roomState.isRunning = false;
    roomState.streamController = null;
    stopButton.disabled = !roomState.autoLoop;
    startButton.disabled = roomState.autoLoop;
    nextTurnButton.disabled = roomState.autoLoop || roomState.history.length === 0;
    newsButton.disabled = roomState.autoLoop;

    if (roomState.autoLoop) {
      window.setTimeout(() => {
        if (roomState.autoLoop && !roomState.isRunning) {
          runConversationTurn({ reset: false, autoLoop: true });
        }
      }, 1200);
    }
  }
}

async function streamConversationTurn(payload) {
  const response = await fetch('/api/debate/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: payload.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Conversation stream failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      handleStreamEvent(JSON.parse(line));
    }
  }

  if (buffer.trim()) {
    handleStreamEvent(JSON.parse(buffer));
  }
}

function handleStreamEvent(event) {
  switch (event.type) {
    case 'round_start':
      setStatus(`IRC cycle ${event.round} is live on "${event.topic}".`);
      break;
    case 'speaker_thinking':
      showThinkingBubble(event.speaker, `${speakerElements[event.speaker].name} is thinking...`);
      break;
    case 'speaker_ready':
      setSpeakerState(event.speaker, {
        mood: event.mood,
        expression: event.expression,
        thought: event.thought,
        model: `${event.provider} - ${event.model}`,
      });
      showThinkingBubble(event.speaker, event.thought);
      roomState.streamingReplies[event.speaker] = '';
      break;
    case 'speaker_chunk':
      roomState.streamingReplies[event.speaker] += event.chunk;
      showSpeechBubble(event.speaker, roomState.streamingReplies[event.speaker]);
      break;
    case 'speaker_done':
      roomState.streamingReplies[event.speaker] = event.turn.reply;
      setSpeakerState(event.speaker, {
        mood: event.turn.mood,
        expression: event.turn.expression,
        thought: event.turn.thought,
        model: `${event.turn.provider} - ${event.turn.model}`,
      });
      clearThinkingBubble(event.speaker);
      showSpeechBubble(event.speaker, event.turn.reply);
      addTranscriptEntry(event.turn.nick || speakerElements[event.turn.speaker].name, event.turn.reply, event.turn.provider);
      break;
    case 'round_complete':
      roomState.history = event.history ?? roomState.history;
      roomState.round = event.round ?? roomState.round + 1;
      syncSpeakerPanels(event.speakers);
      setStatus(
        roomState.autoLoop
          ? `Cycle ${roomState.round} finished. Keeping the room going.`
          : `Cycle ${roomState.round} finished. Click "More thoughts" for one more pass.`
      );
      break;
    case 'error':
      throw new Error(event.message || 'Stream error');
    default:
      break;
  }
}

async function fetchNews() {
  const topic = newsTopicInput.value.trim() || topicInput.value.trim() || 'world news';
  setStatus(`Fetching public news for "${topic}".`);
  newsButton.disabled = true;

  try {
    const response = await fetch(`/api/news?topic=${encodeURIComponent(topic)}`);
    if (!response.ok) {
      throw new Error(`News request failed with ${response.status}`);
    }

    const data = await response.json();
    renderNews(data.items ?? []);
    setStatus(`Loaded ${data.items?.length ?? 0} news items.`);
  } catch (error) {
    console.error(error);
    newsList.innerHTML = '';
    const item = document.createElement('li');
    item.className = 'news-empty';
    item.textContent = 'Could not load public news right now.';
    newsList.appendChild(item);
    setStatus('Public news could not be loaded.');
  } finally {
    if (!roomState.autoLoop && !roomState.isRunning) {
      newsButton.disabled = false;
    }
  }
}

function renderNews(items) {
  newsList.innerHTML = '';

  if (!items.length) {
    const item = document.createElement('li');
    item.className = 'news-empty';
    item.textContent = 'No public news items matched that topic.';
    newsList.appendChild(item);
    return;
  }

  for (const story of items) {
    const item = document.createElement('li');
    item.className = 'news-item';
    item.innerHTML = `
      <button type="button" class="news-pick">
        <span class="news-source">${escapeHtml(story.source || 'Public News')}</span>
        <strong>${escapeHtml(story.title)}</strong>
        <p>${escapeHtml(story.summary || 'No summary available.')}</p>
      </button>
    `;

    item.querySelector('button').addEventListener('click', () => {
      roomState.selectedNews = story;
      topicInput.value = story.title;
      if (!contextInput.value.trim()) {
        contextInput.value = `${story.summary || ''}\n${story.link || ''}`.trim();
      }
      setStatus(`Loaded topic from ${story.source || 'public news'}.`);
    });

    newsList.appendChild(item);
  }
}

function addTranscriptEntry(speaker, text, provider = '') {
  const timestamp = formatTime(new Date());
  const item = document.createElement('article');
  item.className = 'transcript-entry';
  item.innerHTML = `
    <header>
      <span>[${escapeHtml(timestamp)}] ${escapeHtml(speaker)}</span>
      <small>${escapeHtml(provider)}</small>
    </header>
    <p>${escapeHtml(text)}</p>
  `;
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function buildContextText() {
  const parts = [];
  const directContext = contextInput.value.trim();
  if (directContext) {
    parts.push(directContext);
  }

  if (roomState.selectedNews?.link) {
    parts.push(`Selected news link: ${roomState.selectedNews.link}`);
  }

  return parts.join('\n\n');
}

function syncSpeakerPanels(speakers = {}) {
  for (const agent of AGENTS) {
    const speaker = speakers[agent.key] || {};
    setSpeakerState(agent.key, {
      mood: speaker.mood || 'ready',
      expression: speaker.expression || 'steady',
      thought: speaker.thought || 'waiting for the room to move.',
      model: speaker.model || 'LLM room guest',
    });
  }
}

function setSpeakerState(key, { mood, expression, thought, model }) {
  const avatar = avatars[key];
  const panel = speakerElements[key];

  if (mood) {
    if (panel.mood) panel.mood.textContent = `Mood: ${mood}`;
    avatar.state.mood = mood;
  }
  if (expression) {
    if (panel.expression) panel.expression.textContent = `Expression: ${expression}`;
    avatar.state.expression = expression;
    drawTextPanel(avatar.badge, expressionToBadge(expression));
  }
  if (thought) {
    if (panel.thought) panel.thought.textContent = `Thinking: ${thought}`;
    avatar.state.thought = thought;
  }
  if (model) {
    if (panel.model) panel.model.textContent = String(model).replaceAll('Â·', '-').replaceAll('·', '-');
  }

  avatar.aura.material.color.set(moodToColor(key, avatar.state.mood));
}

function createAgent(agent) {
  const group = new THREE.Group();
  group.position.set(agent.x, 0, 0.55);

  const podium = new THREE.Mesh(
    new THREE.CylinderGeometry(0.95, 1.05, 0.78, 24),
    new THREE.MeshStandardMaterial({ color: agent.podiumColor, roughness: 0.94 })
  );
  podium.receiveShadow = true;
  podium.position.y = 0.42;
  group.add(podium);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 1.28, 4, 12),
    new THREE.MeshStandardMaterial({ color: agent.bodyColor, roughness: 0.78 })
  );
  body.position.y = 1.58;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.39, 24, 24),
    new THREE.MeshStandardMaterial({ color: agent.headColor, roughness: 0.9 })
  );
  head.position.y = 2.64;
  head.castShadow = true;
  group.add(head);

  const aura = new THREE.Mesh(
    new THREE.TorusGeometry(0.8, 0.075, 16, 40),
    new THREE.MeshBasicMaterial({ color: agent.auraColor })
  );
  aura.rotation.x = Math.PI / 2;
  aura.position.y = 1.12;
  group.add(aura);

  const badge = createTextSprite(agent.label, {
    background: 'rgba(255,255,255,0.9)',
    foreground: '#111111',
    accent: agent.accent,
    width: 280,
    height: 138,
    fontSize: 46,
    lineHeight: 54,
    maxLines: 2,
  });
  badge.position.set(0, 2.72, 0.7);
  group.add(badge);

  const nameLabel = createTextSprite(agent.name, {
    background: 'rgba(0,0,0,0.62)',
    foreground: '#ffffff',
    accent: agent.accent,
    width: 480,
    height: 110,
    fontSize: 36,
    lineHeight: 44,
    maxLines: 1,
  });
  nameLabel.position.set(0, 0.58, 0.7);
  group.add(nameLabel);

  const thoughtBubble = createTextSprite('', {
    background: 'rgba(255,255,255,0.95)',
    foreground: '#102032',
    accent: agent.accent,
    width: 700,
    height: 340,
    fontSize: 34,
    lineHeight: 42,
    maxLines: 6,
  });
  thoughtBubble.position.set(0, 5.15, 0.44);
  thoughtBubble.visible = false;
  group.add(thoughtBubble);

  const speechBubble = createTextSprite('', {
    background: agent.bubbleBackground,
    foreground: '#101214',
    accent: agent.accent,
    width: 840,
    height: 420,
    fontSize: 38,
    lineHeight: 46,
    maxLines: 7,
  });
  speechBubble.position.set(0, 6.75, 0.32);
  speechBubble.visible = false;
  group.add(speechBubble);

  return {
    group,
    body,
    aura,
    badge,
    nameLabel,
    thoughtBubble,
    speechBubble,
    state: {
      mood: 'ready',
      expression: 'steady',
      thought: '',
    },
  };
}

function createTextSprite(text, options) {
  const spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = options.width;
  spriteCanvas.height = options.height;
  const context = spriteCanvas.getContext('2d');
  const texture = new THREE.CanvasTexture(spriteCanvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(options.width / 220, options.height / 220, 1);
  sprite.userData = { spriteCanvas, context, texture, options };
  drawTextPanel(sprite, text);
  return sprite;
}

function drawTextPanel(sprite, text) {
  const { spriteCanvas, context, texture, options } = sprite.userData;
  const { width, height, background, foreground, accent, fontSize, lineHeight, maxLines } = options;
  context.clearRect(0, 0, width, height);

  context.fillStyle = background;
  roundRect(context, 22, 22, width - 44, height - 44, 34);
  context.fill();

  context.strokeStyle = accent;
  context.lineWidth = 8;
  roundRect(context, 22, 22, width - 44, height - 44, 34);
  context.stroke();

  context.fillStyle = accent;
  context.fillRect(42, 40, width - 84, 12);

  context.fillStyle = foreground;
  context.font = `bold ${fontSize}px sans-serif`;
  context.textAlign = 'left';
  context.textBaseline = 'top';

  const lines = wrapText(context, String(text || ''), width - 116).slice(0, maxLines);
  const contentHeight = lines.length * lineHeight;
  let y = Math.max(64, (height - contentHeight) / 2);

  for (const line of lines) {
    context.fillText(line, 58, y);
    y += lineHeight;
  }

  texture.needsUpdate = true;
}

function showThinkingBubble(key, text) {
  const avatar = avatars[key];
  avatar.thoughtBubble.visible = true;
  drawTextPanel(avatar.thoughtBubble, clampBubbleText(text, 260));
}

function clearThinkingBubble(key) {
  avatars[key].thoughtBubble.visible = false;
}

function showSpeechBubble(key, text) {
  const avatar = avatars[key];
  avatar.speechBubble.visible = true;
  drawTextPanel(avatar.speechBubble, clampBubbleText(text, 320));
}

function hideSpeechBubble(key) {
  avatars[key].speechBubble.visible = false;
}

function addLights() {
  const hemi = new THREE.HemisphereLight('#edf7ff', '#4c5a77', 1.55);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight('#fff5df', 2.35);
  keyLight.position.set(4, 12, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -18;
  keyLight.shadow.camera.right = 18;
  keyLight.shadow.camera.top = 16;
  keyLight.shadow.camera.bottom = -16;
  scene.add(keyLight);

  const rim = new THREE.PointLight('#b9d5ff', 18, 26);
  rim.position.set(0, 5.8, -8);
  scene.add(rim);
}

function addSet() {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(16, 72),
    new THREE.MeshStandardMaterial({ color: '#111827', roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const stage = new THREE.Mesh(
    new THREE.CylinderGeometry(8.8, 9.6, 0.64, 56),
    new THREE.MeshStandardMaterial({ color: '#233045', roughness: 0.92 })
  );
  stage.position.y = 0.2;
  stage.receiveShadow = true;
  scene.add(stage);

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 9),
    new THREE.MeshStandardMaterial({ color: '#7086b9', roughness: 0.98 })
  );
  backdrop.position.set(0, 4.7, -6.6);
  scene.add(backdrop);
}

function seedTranscript() {
  addTranscriptEntry('topic_bot', 'Set a topic or pull in public news, then start the IRC room.', 'system');
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function wrapText(context, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [''];
  }

  const lines = [];
  let current = words[0];

  for (let index = 1; index < words.length; index += 1) {
    const candidate = `${current} ${words[index]}`;
    if (context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = words[index];
    } else {
      current = candidate;
    }
  }

  lines.push(current);
  return lines;
}

function expressionToBadge(expression) {
  const labels = {
    steady: '=:',
    focused: '><',
    considering: '..',
    assertive: '!!',
    skeptical: ':/',
    upbeat: ':)',
  };
  return labels[expression] || '=:';
}

function moodToColor(key, mood) {
  const palettes = {
    openai: { ready: '#5fe3b1', focused: '#42d392', attentive: '#5cc7ff', analytical: '#95f0cf', skeptical: '#e9ff8c', fallback: '#5fe3b1' },
    builder: { ready: '#81a7ff', focused: '#67b3ff', attentive: '#9ab8ff', analytical: '#7fd4ff', skeptical: '#c1d4ff', fallback: '#81a7ff' },
    claude: { ready: '#ffad7a', focused: '#ff8d5d', attentive: '#ffd27f', analytical: '#ffc68f', skeptical: '#ff9fb7', fallback: '#ffad7a' },
    skeptic: { ready: '#d39bff', focused: '#c77dff', attentive: '#e4b8ff', analytical: '#f1b5ff', skeptical: '#ff9fe2', fallback: '#d39bff' },
  };
  return palettes[key][mood] || palettes[key].fallback;
}

function clampBubbleText(text, maxLength) {
  const value = String(text ?? '').trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  const elapsed = clock.getElapsedTime();
  for (const [index, agent] of AGENTS.entries()) {
    const avatar = avatars[agent.key];
    avatar.body.rotation.z = Math.sin(elapsed * (1.4 + index * 0.1)) * 0.012;
    avatar.badge.lookAt(camera.position);
    avatar.nameLabel.lookAt(camera.position);
    avatar.thoughtBubble.lookAt(camera.position);
    avatar.speechBubble.lookAt(camera.position);
    avatar.thoughtBubble.position.y = 5.15 + Math.sin(elapsed * 2.2 + index) * 0.05;
    avatar.speechBubble.position.y = 6.75 + Math.cos(elapsed * 1.7 + index) * 0.06;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(date) {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

animate();
