export interface OmanHoliday {
  /** Calendar day, YYYY-MM-DD. */
  date: string
  name: string
  isReligious: boolean
}

// Oman's Ministry of Labour announces the public holidays at the start of each Gregorian year, and the Eid holidays
// shortly before each Eid. Only years that have been announced are listed here: nothing is calculated or guessed.
//
// 2026: announced 28 December 2025 (Oman Observer, Times of Oman). Eid al-Fitr: Ministry of Labour, 11 March 2026
// (Muscat Daily). Eid al-Adha 27 to 31 May is as reported by news sites; the Ministry's own notice was not found.
// Renaissance Day (23 July) is no longer a public holiday.
const ANNOUNCED: Record<number, OmanHoliday[]> = {
  2026: [
    { date: '2026-01-15', name: "Accession Day of His Majesty the Sultan", isReligious: false },
    { date: '2026-01-18', name: "Isra and Mi'raj", isReligious: true },
    { date: '2026-03-19', name: 'Eid al-Fitr holiday (day 1 of 5)', isReligious: true },
    { date: '2026-03-20', name: 'Eid al-Fitr holiday (day 2 of 5)', isReligious: true },
    { date: '2026-03-21', name: 'Eid al-Fitr holiday (day 3 of 5)', isReligious: true },
    { date: '2026-03-22', name: 'Eid al-Fitr holiday (day 4 of 5)', isReligious: true },
    { date: '2026-03-23', name: 'Eid al-Fitr holiday (day 5 of 5)', isReligious: true },
    { date: '2026-05-27', name: 'Eid al-Adha holiday (day 1 of 5)', isReligious: true },
    { date: '2026-05-28', name: 'Eid al-Adha holiday (day 2 of 5)', isReligious: true },
    { date: '2026-05-29', name: 'Eid al-Adha holiday (day 3 of 5)', isReligious: true },
    { date: '2026-05-30', name: 'Eid al-Adha holiday (day 4 of 5)', isReligious: true },
    { date: '2026-05-31', name: 'Eid al-Adha holiday (day 5 of 5)', isReligious: true },
    { date: '2026-06-18', name: 'Hijri New Year', isReligious: true },
    { date: '2026-08-27', name: "Prophet Muhammad's Birthday", isReligious: true },
    { date: '2026-11-25', name: 'National Day (day 1 of 2)', isReligious: false },
    { date: '2026-11-26', name: 'National Day (day 2 of 2)', isReligious: false },
  ],
}

export const ANNOUNCED_YEARS = Object.keys(ANNOUNCED).map(Number)

/** The public holidays Oman has announced for a year, in date order. A year that has not been announced has none. */
export function omanHolidays(year: number): OmanHoliday[] {
  return [...(ANNOUNCED[year] ?? [])].sort((a, b) => a.date.localeCompare(b.date))
}
