// Harder reasoning tier — gradient-producing multi-step items where strong models
// still separate (the base `reasoning` set is ceiling-bound at ~12/12 for top models).
// Same shape as cases.mjs (question / accepted / trap), so the existing grader handles
// them once merged. Answers are deterministic single tokens/numbers.
export const HARD_CASES = {
   'clock-angle': {
      question: 'What is the angle in degrees between the hour and minute hands of a clock at exactly 3:15? Answer with the number only.',
      accepted: ['7.5', '7.5 degrees', '7.50'],
      trap: '0',
   },
   'ages-product': {
      question:
         'A father is 4 times as old as his son. In 20 years he will be twice as old as his son. How old is the son now? Answer with the number only.',
      accepted: ['10', '10 years'],
      trap: '20',
   },
   handshake: {
      question:
         'At a party every person shakes hands with every other person exactly once. There were 66 handshakes total. How many people were at the party? Answer with the number only.',
      accepted: ['12', '12 people'],
      trap: '66',
   },
   'burning-ropes': {
      question:
         'You have two ropes that each take exactly 60 minutes to burn end-to-end, but burn at a non-uniform rate. Using only these ropes and a lighter, what is the largest single time interval under one hour, in minutes, that you can measure exactly? Answer with the number only.',
      accepted: ['45', '45 minutes'],
      trap: '30',
   },
   'monty-hall': {
      question:
         'In the Monty Hall problem with 3 doors, after the host opens a losing door, what is the probability of winning if you switch? Answer as a fraction like 2/3.',
      accepted: ['2/3', '0.667', '0.67', '66.7%', '2 3'],
      trap: '1/2',
   },
   'river-crossing': {
      question:
         'A farmer must cross a river with a wolf, a goat, and a cabbage; the boat holds the farmer plus one item. Wolf eats goat, goat eats cabbage if left alone together. What is the minimum number of river crossings needed? Answer with the number only.',
      accepted: ['7', '7 crossings'],
      trap: '3',
   },
};
