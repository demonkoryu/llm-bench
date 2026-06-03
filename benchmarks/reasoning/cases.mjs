/** Reasoning cases — question text, accepted answers, and trap values. Keyed by case_id. */
export const CASES = {
   'bat-and-ball': {
      question: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost?',
      accepted: ['5', '5 cents', '$0.05', '0.05'],
      trap: '10',
   },
   widgets: {
      question: 'If 5 machines take 5 minutes to make 5 widgets, how many minutes do 100 machines take to make 100 widgets?',
      accepted: ['5', '5 minutes'],
      trap: '100',
   },
   'lily-pad': {
      question:
         'A patch of lily pads doubles in size every day. It takes 48 days to cover the whole lake. On what day number was the lake half covered?',
      accepted: ['47', 'day 47'],
      trap: '24',
   },
   'all-but-9': {
      question: 'A farmer has 17 sheep. All but 9 die. How many sheep are left alive?',
      accepted: ['9', '9 sheep'],
      trap: '8',
   },
   'apples-fractions': {
      question:
         'A store starts with 120 apples. It sells one third of them in the morning, then one quarter of the REMAINING apples in the afternoon. How many apples are left at the end of the day?',
      accepted: ['60', '60 apples'],
      trap: '50',
   },
   'age-order': {
      question:
         'Alice is older than Bob. Carol is younger than Bob. Dave is older than Alice. Among Alice, Bob, Carol, and Dave, who is the oldest? Give the single name.',
      accepted: ['dave'],
      trap: 'alice',
   },
   'days-100': {
      question: 'Today is Wednesday. What day of the week will it be exactly 100 days from now? Give the weekday name.',
      accepted: ['friday'],
      trap: 'wednesday',
   },
   'count-sevens': {
      question:
         'Counting through the whole numbers from 1 to 100 inclusive, how many times does the digit 7 appear in total (e.g. 77 contains the digit 7 twice)?',
      accepted: ['20'],
      trap: '19',
   },
   'next-in-sequence': {
      question: 'What is the next number in this sequence: 2, 6, 12, 20, 30, ? Give just the number.',
      accepted: ['42'],
      trap: '40',
   },
   'modus-tollens': {
      question:
         'Rule: If it is raining, then the ground is wet. Observation: the ground is NOT wet. Based only on this, is it raining? Answer yes or no.',
      accepted: ['no'],
      trap: 'yes',
   },
   socks: {
      question:
         'A drawer has 10 red socks and 10 blue socks mixed together in the dark. How many socks must you pull out, at minimum, to be GUARANTEED a matching pair?',
      accepted: ['3', '3 socks'],
      trap: '2',
   },
   overtaking: {
      question: 'In a race, you overtake the runner in second place. What position are you in now? Give the ordinal (e.g. first, second).',
      accepted: ['second', '2nd'],
      trap: 'first',
   },
};
