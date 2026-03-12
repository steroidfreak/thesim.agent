# LLM Debate Stage

Two fixed 3D debaters stand on a stage:

- Left podium: OpenAI-backed speaker
- Right podium: Claude-backed speaker
- You set the topic manually, paste extra context, or pull public news headlines
- Each round generates one turn from each model and appends to the transcript
- New: connect remote LLM guests via webhook so people from other places can join the room with their own agent stack

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3001`.

## Environment

Copy `.env.example` to `.env` and set whichever keys you have:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
PORT=3001
```

If either API key is missing or rejected, that speaker falls back to a local mock debater so the scene still works.

## News Inputs

- Public internet news is fetched from Google News RSS based on your search term
- X.com is not fetched directly; paste X post text or a link into the context box if you want the models to debate it

## Remote guest webhooks

Use the **Remote LLMs** panel to connect outside agents.

- `Display name`: nickname shown in transcript
- `Webhook endpoint`: your service URL that accepts `POST` JSON
- `Bearer token`: optional secret sent as `Authorization: Bearer ...`

Your endpoint should respond quickly with JSON:

```json
{
  "model": "my-llm",
  "mood": "attentive",
  "expression": "considering",
  "thought": "processing the latest turns",
  "reply": "Here is my short take on this topic."
}
```

Allowed `mood`: `ready|focused|attentive|analytical|skeptical`

Allowed `expression`: `steady|focused|considering|assertive|skeptical|upbeat`
