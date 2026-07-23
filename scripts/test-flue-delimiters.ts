/**
 * Test script: Reproduce Flue delimiter failure locally.
 * 
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx scripts/test-flue-delimiters.ts [/path/to/diff]
 */

import * as fs from 'fs';
import {
  buildReviewPrompt,
  type ReviewPromptContext,
} from '../src/workflows/code-review/prompts/builder';

// ─── Flue's prompt augmentation (replicated from @flue/client) ───

const HEADLESS_PREAMBLE =
  'You are running in headless mode with no human operator. Work autonomously — never ask questions, never wait for user input, never use the question tool. Make your best judgment and proceed independently.';

function buildFlueResultInstructions(): string {
  const schemaJson = JSON.stringify({ type: 'string' }, null, 2);
  return [
    '',
    '```json',
    schemaJson,
    '```',
    '',
    'Example: (Object)',
    '---RESULT_START---',
    '{"key": "value"}',
    '---RESULT_END---',
    '',
    'Example: (String)',
    '---RESULT_START---',
    'Hello, world!',
    '---RESULT_END---',
  ].join('\n');
}

function buildFluePrompt(reviewPrompt: string): string {
  return [
    HEADLESS_PREAMBLE,
    '',
    reviewPrompt,
    'When complete, you MUST output your result between these exact delimiters conforming to this schema:',
    buildFlueResultInstructions(),
  ].join('\n');
}

// ─── OpenAI API calls ───

async function callChatModel(prompt: string, model: string): Promise<{ response: string; raw: any }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    return { response: '', raw: json };
  }
  const response = json.choices?.[0]?.message?.content ?? '';
  return { response, raw: json };
}

async function callCompletionModel(prompt: string, model: string): Promise<{ response: string; raw: any }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    return { response: '', raw: json };
  }
  const response = json.choices?.[0]?.text ?? '';
  return { response, raw: json };
}

async function callModel(prompt: string, model: string): Promise<{ response: string; raw: any }> {
  // Codex models use legacy completions API, not chat completions
  const isCodex = model.includes('codex');
  console.log(`   (using ${isCodex ? 'completions' : 'chat'} endpoint for ${model})`);
  
  if (isCodex) {
    return callCompletionModel(prompt, model);
  }
  return callChatModel(prompt, model);
}

// ─── Main ───

async function main() {
  const MODEL = process.env.TEST_MODEL || 'gpt-5.3-codex';

  const prDiffPath = process.argv[2] || '/tmp/test-pr-diff-3317.diff';
  const diffText = fs.readFileSync(prDiffPath, 'utf-8');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🧪 Flue Delimiter Test — Model: ${MODEL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step 1: Build the review prompt
  const reviewPrompt = buildReviewPrompt(
    {
      owner: 'tableoltd',
      repo: 'rms',
      prNumber: 3317,
      retrigger: false,
      instruction: undefined,
      previousComments: [],
      diffText,
      repoContext: undefined,
    } satisfies ReviewPromptContext,
  );

  console.log(`\n📝 Review prompt length: ${reviewPrompt.length} chars`);

  // Step 2: Build the full Flue prompt
  const fullPrompt = buildFluePrompt(reviewPrompt);
  console.log(`📦 Full Flue prompt length: ${fullPrompt.length} chars`);

  // Step 3: Show the delimiter instructions
  const delimiterIdx = fullPrompt.indexOf('When complete, you MUST output');
  console.log(`\n🔍 Flue delimiter section (last ${fullPrompt.length - (delimiterIdx >= 0 ? delimiterIdx : fullPrompt.length)} chars):`);
  console.log(fullPrompt.slice(delimiterIdx));
  console.log('────────────────────────────────────────────────────');

  // Step 4: Call the model
  console.log(`\n🚀 Calling ${MODEL}...\n`);
  const start = Date.now();
  
  const { response, raw } = await callModel(fullPrompt, MODEL);
  
  if (raw.error) {
    console.error(`\n❌ API error: ${JSON.stringify(raw.error, null, 2)}`);
    return;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`✅ Response received in ${elapsed}s`);
  if (raw.usage) {
    console.log(`📊 Tokens: prompt=${raw.usage.prompt_tokens}, completion=${raw.usage.completion_tokens}`);
  }

  // Step 5: Analyze
  const hasStart = response.includes('---RESULT_START---');
  const hasEnd = response.includes('---RESULT_END---');
  const hasJsonBlock = response.match(/```json\n([\s\S]*?)\n```/);
  const hasPlainJson = response.trim().startsWith('{') && response.trim().endsWith('}');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📋 MODEL RESPONSE (${response.length} chars):`);
  console.log(`   ---RESULT_START---: ${hasStart ? '✅ FOUND' : '❌ NOT FOUND'}`);
  console.log(`   ---RESULT_END---:   ${hasEnd ? '✅ FOUND' : '❌ NOT FOUND'}`);
  if (hasJsonBlock) console.log('   ```json block:     ⚠️  FOUND');
  if (hasPlainJson) console.log('   Plain JSON:        ⚠️  FOUND (no delimiters)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(response);
  console.log('\n────────────────────────────────────────────────────');

  if (hasStart && hasEnd) {
    console.log('\n✅ Flue would SUCCEED — delimiters found.');
  } else if (hasPlainJson || hasJsonBlock) {
    console.log('\n⚠️  Flue would FAIL — but our NEW fallback would extract the JSON successfully.');
  } else {
    console.log('\n❌ Flue would FAIL — and no fallback possible.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
