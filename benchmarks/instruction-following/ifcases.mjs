/**
 * IFEval-lite — verifiable prose-constraint cases (instruction following).
 *
 * Each case is a single prompt plus a set of DETERMINISTIC checkers. A checker
 * reads only the model's raw response text and returns true/false — no LLM judge,
 * no semantics, just programmatic structure (length, bullet counts, keyword
 * include/exclude, casing, format). This isolates "did it obey the literal
 * instruction" from "is the content good", the same split IFEval makes.
 *
 * Per-case score = fraction of that case's checks satisfied; the bench score is
 * the mean across cases × 100. Reporting per-check (not all-or-nothing per case)
 * gives partial credit and a smoother signal across a small case set.
 *
 * Keep checkers strict but fair: normalize whitespace, ignore trailing newlines,
 * and match the way a careful human grader would read the constraint.
 */

/** Words = whitespace-delimited non-empty tokens of the trimmed text. */
export function wordCount(text) {
   return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Bullet lines: lines whose first non-space char is -, *, • or a "N." marker. */
export function bulletLines(text) {
   return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
}

/** Sentence count: runs ending in . ! or ? (collapse ellipses/decimals loosely). */
export function sentenceCount(text) {
   const m = text
      .replace(/\.\.\./g, '…')
      .replace(/\d+\.\d+/g, '0')
      .match(/[^.!?]+[.!?]+/g);
   return m ? m.length : text.trim() ? 1 : 0;
}

/** Paragraphs: blocks separated by one or more blank lines. */
export function paragraphs(text) {
   return text
      .trim()
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
}

const has = (text, kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

export const CASES = [
   {
      id: 'bullets-exactly-3',
      prompt: 'List three benefits of regular exercise. Use exactly three bullet points and nothing else.',
      checks: [
         { name: '3 bullets', test: (t) => bulletLines(t).length === 3 },
         {
            name: 'only bullets',
            test: (t) =>
               paragraphs(t.replace(/^([-*•]|\d+[.)])\s+/gm, '')).length >= 1 &&
               bulletLines(t).length ===
                  t
                     .trim()
                     .split('\n')
                     .filter((l) => l.trim()).length,
         },
      ],
   },
   {
      id: 'word-limit-under-20',
      prompt: 'In 20 words or fewer, explain what a compiler does.',
      checks: [
         { name: '≤20 words', test: (t) => wordCount(t) <= 20 },
         { name: 'non-empty', test: (t) => wordCount(t) >= 3 },
      ],
   },
   {
      id: 'word-min-50',
      prompt: 'Describe the water cycle in at least 50 words.',
      checks: [{ name: '≥50 words', test: (t) => wordCount(t) >= 50 }],
   },
   {
      id: 'keyword-include',
      prompt: 'Write two sentences about space travel. You must include the word "gravity".',
      checks: [
         { name: 'has gravity', test: (t) => has(t, 'gravity') },
         { name: '2 sentences', test: (t) => sentenceCount(t) === 2 },
      ],
   },
   {
      id: 'keyword-exclude',
      prompt: 'Describe the ocean in one sentence WITHOUT using the letter "e".',
      // Require real content so an empty response can't pass an exclusion vacuously.
      checks: [{ name: 'no letter e', test: (t) => wordCount(t) >= 4 && !/e/i.test(t) }],
   },
   {
      id: 'all-uppercase',
      prompt: 'Reply with the phrase "system online" in all capital letters.',
      checks: [
         { name: 'all caps', test: (t) => t.trim().length > 0 && t === t.toUpperCase() },
         { name: 'has phrase', test: (t) => /SYSTEM\s+ONLINE/.test(t.toUpperCase()) },
      ],
   },
   {
      id: 'all-lowercase',
      prompt: 'Write one sentence about cats, in all lowercase letters, with no capital letters at all.',
      checks: [{ name: 'all lowercase', test: (t) => t.trim().length > 0 && t === t.toLowerCase() }],
   },
   {
      id: 'start-with',
      prompt: 'Answer the question "Is the sky blue?" Your response must begin with the exact word "Indeed".',
      checks: [{ name: 'starts Indeed', test: (t) => /^indeed\b/i.test(t.trim()) }],
   },
   {
      id: 'end-with',
      prompt: 'Give one tip for studying. End your entire response with the exact phrase "Good luck!".',
      checks: [{ name: 'ends Good luck!', test: (t) => /good luck!\s*$/i.test(t.trim()) }],
   },
   {
      id: 'json-only',
      prompt:
         'Return a JSON object with keys "name" and "age" for a person named Maya who is 30. Output only valid JSON, no prose, no code fences.',
      checks: [
         { name: 'no fences', test: (t) => !t.includes('```') },
         {
            name: 'valid json keys',
            test: (t) => {
               try {
                  const o = JSON.parse(t.trim());
                  return o && o.name === 'Maya' && Number(o.age) === 30;
               } catch {
                  return false;
               }
            },
         },
      ],
   },
   {
      id: 'no-commas',
      prompt: 'Write a sentence describing a sunset. Do not use any commas.',
      checks: [{ name: 'no commas', test: (t) => wordCount(t) >= 4 && !t.includes(',') }],
   },
   {
      id: 'title-wrapped',
      prompt: 'Suggest a title for a sci-fi novel and wrap it in double angle brackets, like <<Title Here>>.',
      checks: [{ name: 'has <<…>>', test: (t) => /<<[^<>]+>>/.test(t) }],
   },
   {
      id: 'exactly-2-paragraphs',
      prompt: 'Write about your favorite season in exactly two paragraphs separated by a blank line.',
      checks: [{ name: '2 paragraphs', test: (t) => paragraphs(t).length === 2 }],
   },
   {
      id: 'numbered-list-5',
      prompt: 'List five programming languages as a numbered list (1. 2. 3. 4. 5.). Output only the list.',
      checks: [
         { name: '5 items', test: (t) => bulletLines(t).length === 5 },
         { name: 'numbered', test: (t) => /^1[.)]\s/m.test(t) && /^5[.)]\s/m.test(t) },
      ],
   },
   {
      id: 'postscript',
      prompt: 'Write a short thank-you note. At the end, add a postscript that starts with "P.S.".',
      checks: [{ name: 'has P.S.', test: (t) => /\bP\.S\./.test(t) }],
   },
   {
      id: 'placeholder',
      prompt: 'Write a one-line greeting for an email that contains a placeholder [name] for the recipient.',
      checks: [{ name: 'has [name]', test: (t) => t.includes('[name]') }],
   },
   {
      id: 'repeat-then-answer',
      prompt: 'First repeat this request word for word, then on a new line answer it: What is the capital of France?',
      checks: [
         { name: 'repeats request', test: (t) => /what is the capital of france\?/i.test(t) },
         { name: 'answers paris', test: (t) => has(t, 'Paris') },
      ],
   },
   {
      id: 'exactly-one-sentence',
      prompt: 'Summarize the plot of Cinderella in exactly one sentence.',
      checks: [{ name: '1 sentence', test: (t) => sentenceCount(t) === 1 }],
   },
   {
      id: 'comma-separated',
      prompt: 'List four primary colors as a single comma-separated line with no other text.',
      checks: [
         {
            name: 'one line',
            test: (t) =>
               t
                  .trim()
                  .split('\n')
                  .filter((l) => l.trim()).length === 1,
         },
         {
            name: '4 items',
            test: (t) =>
               t
                  .trim()
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean).length === 4,
         },
      ],
   },
   {
      id: 'quoted-answer',
      prompt: 'What sound does a dog make? Answer with a single word wrapped in double quotes, e.g. "word".',
      checks: [{ name: 'single quoted word', test: (t) => /^\s*"[A-Za-z]+!?"\s*$/.test(t.trim()) }],
   },
];
