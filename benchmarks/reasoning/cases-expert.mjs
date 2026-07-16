// Expert reasoning tier — genuinely hard, multi-step problems with unambiguous answers,
// chosen to produce a GRADIENT (strong models still miss some), so it can actually
// discriminate model capability where `reasoning_hard` is ceiling-bound. Same shape as
// cases.mjs (question / accepted / trap); the reasoning grader merges these.
export const EXPERT_CASES = {
   'incl-excl': {
      question: 'How many positive integers less than 1000 are divisible by neither 5 nor 7? Answer with the number only.',
      accepted: ['686'],
      trap: '687',
   },
   surjections: {
      question:
         'In how many ways can 5 distinct books be distributed to 3 distinct students so that each student gets at least one book? Answer with the number only.',
      accepted: ['150'],
      trap: '243',
   },
   'mod-exp': {
      question: 'What is the remainder when 7^100 is divided by 13? Answer with the number only.',
      accepted: ['9'],
      trap: '1',
   },
   'trailing-zeros': {
      question: 'How many trailing zeros does 100! (100 factorial) have? Answer with the number only.',
      accepted: ['24'],
      trap: '20',
   },
   'last-two-digits': {
      question: 'What are the last two digits of 7^2023? Answer with the two-digit number only.',
      accepted: ['43'],
      trap: '07',
   },
   'cube-identity': {
      question: 'If x + 1/x = 3, what is the value of x^3 + 1/x^3? Answer with the number only.',
      accepted: ['18'],
      trap: '27',
   },
   committee: {
      question:
         'A committee of 3 people is chosen from 6 men and 4 women. How many possible committees include at least one woman? Answer with the number only.',
      accepted: ['100'],
      trap: '120',
   },
   snail: {
      question:
         'A snail is at the bottom of a 30-foot well. Each day it climbs up 3 feet, and each night it slides back 2 feet. On which day does it first reach the top? Answer with the day number only.',
      accepted: ['28'],
      trap: '30',
   },
   'euclid-gcd': {
      question: 'What is the greatest common divisor of 1071 and 462? Answer with the number only.',
      accepted: ['21'],
      trap: '7',
   },
   banana: {
      question: 'How many distinct arrangements are there of the letters in the word BANANA? Answer with the number only.',
      accepted: ['60'],
      trap: '720',
   },
   'polygon-sides': {
      question: 'A regular polygon has interior angles of 156 degrees each. How many sides does it have? Answer with the number only.',
      accepted: ['15'],
      trap: '12',
   },
   'divisor-count': {
      question: 'How many positive divisors does 360 have? Answer with the number only.',
      accepted: ['24'],
      trap: '12',
   },
   'consec-even': {
      question: 'The product of two consecutive even integers is 168. What is the larger of the two integers? Answer with the number only.',
      accepted: ['14'],
      trap: '12',
   },
   altitude: {
      question:
         'A right triangle has legs of length 9 and 12. What is the length of the altitude drawn to the hypotenuse? Answer with the number only (a decimal is fine).',
      accepted: ['7.2', '7.20', '36/5'],
      trap: '10.5',
   },
   'coprime-pairs': {
      question: 'How many ordered pairs (a, b) of positive integers satisfy a + b = 50 and gcd(a, b) = 1? Answer with the number only.',
      accepted: ['20'],
      trap: '25',
   },
   'perfect-number': {
      question: 'What is the sum of all positive divisors of 28, including 28 itself? Answer with the number only.',
      accepted: ['56'],
      trap: '28',
   },
};
