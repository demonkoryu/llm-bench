/** Reasoning cases data — accepted answers and trap values. Keyed by case_id. */
export const CASES = {
   'bat-and-ball':     { accepted: ['5', '5 cents', '$0.05', '0.05'],     trap: '10' },
   'widgets':          { accepted: ['5', '5 minutes'],                     trap: '100' },
   'lily-pad':         { accepted: ['47', 'day 47'],                       trap: '24' },
   'all-but-9':        { accepted: ['9', '9 sheep'],                       trap: '8' },
   'apples-fractions': { accepted: ['60', '60 apples'],                    trap: '50' },
   'age-order':        { accepted: ['dave'],                               trap: 'alice' },
   'days-100':         { accepted: ['friday'],                             trap: 'wednesday' },
   'count-sevens':     { accepted: ['20'],                                 trap: '19' },
   'next-in-sequence': { accepted: ['42'],                                 trap: '40' },
   'modus-tollens':    { accepted: ['no'],                                 trap: 'yes' },
   'socks':            { accepted: ['3', '3 socks'],                       trap: '2' },
   'overtaking':       { accepted: ['second', '2nd'],                      trap: 'first' },
};
