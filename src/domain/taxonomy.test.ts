import { describe, expect, it } from 'vitest';

import { classifyAnnouncement } from './taxonomy';

describe('classifyAnnouncement', () => {
  // Titles as filed on BSE (observed 2026-11-01 for RELIANCE) plus common patterns.
  it.each([
    ['Unaudited Financial Results (Consolidated And Standalone) For The Quarter And Half Year Ended September 30, 2026.', 'results'],
    ['Announcement under Regulation 30 (LODR)-Analyst / Investor Meet - Outcome', 'investor_meetings'],
    ['Announcement under Regulation 30 (LODR)-Press Release / Media Release', 'press_release'],
    ['Announcement under Regulation 30 (LODR)-Earnings Call Transcript', 'earnings_call'],
    ['Announcement under Regulation 30 (LODR)-Change in Directorate', 'management_change'],
    ['Resignation of Chief Financial Officer', 'management_change'],
    ['Announcement under Regulation 30 (LODR)-Credit Rating', 'credit_rating'],
    ['Corporate Action-Board approves Dividend', 'dividend'],
    ['Bonus issue of equity shares in the ratio 1:1', 'bonus_split'],
    ['Acquisition of 51% stake in XYZ Private Limited', 'ma'],
    ['Allotment of Commercial Paper', 'fund_raise'],
    ['Disclosure under SEBI (PIT) Regulations, 2015 - Regulation 7(2)', 'insider_trading'],
    ['Disclosure of creation of encumbrance / pledge on shares by promoter', 'pledging'],
    ['Receipt of show cause notice from GST authorities', 'litigation'],
    ['Commissioning of new plant at Dahej', 'capex'],
    ['Postal Ballot Notice', 'postal_ballot'],
    ['Notice of 49th Annual General Meeting', 'agm_egm'],
    ['Newspaper Publication of unaudited financial results', 'results'],
    // Observed on BSE, 2026-11-01:
    ['Q2 & H1 FY 2026-2027 Results Presentation', 'results'],
    ['Announcement under Regulation 30 (LODR)-Cessation', 'management_change'],
    ['Infosys Announces Expansion Of Pocharam Development Center In Hyderabad', 'press_release'],
  ])('%s → %s', (title, category) => {
    const c = classifyAnnouncement(title);
    expect(c.category).toBe(category);
    expect(c.status).toBe('matched');
    expect(c.ruleIds.length).toBeGreaterThan(0);
  });

  it('keeps every matched category when one filing covers several', () => {
    const c = classifyAnnouncement(
      'Board Meeting Outcome for Unaudited Financial Results For The Quarter Ended September 30, 2026 And Issuance Non-Convertible Debentures.',
    );
    expect(c.category).toBe('results');
    expect(c.secondary).toContain('fund_raise');
  });

  it.each([
    ['Closure of Trading Window', 'routine:trading_window'],
    ['Allotment of equity shares under ESOP scheme', 'routine:esop'],
    ['Compliance Certificate under Regulation 74(5)', 'routine:compliance_certificate'],
    ['Appointment of Secretarial Auditor', 'routine:auditor'],
    ['Newspaper Publication - Notice to shareholders', 'routine:newspaper'],
  ])('treats %s as routine', (title, rule) => {
    const c = classifyAnnouncement(title);
    expect(c).toMatchObject({ category: 'unclassified', status: 'routine', ruleIds: [rule] });
  });

  it('does not let routine trading-window filings read as insider trading', () => {
    expect(classifyAnnouncement('Intimation of closure of trading window under SEBI (Prohibition of Insider Trading)').status).toBe('routine');
  });

  it('leaves genuinely ambiguous titles unclassified with candidates', () => {
    const c = classifyAnnouncement('Announcement under Regulation 30 (LODR)-Investor Presentation');
    expect(c).toMatchObject({ category: 'unclassified', status: 'ambiguous' });
    expect(c.secondary).toEqual(['results', 'investor_meetings']);
    expect(classifyAnnouncement('Board Meeting Outcome').status).toBe('ambiguous');
    expect(classifyAnnouncement('Board Meeting Outcome for Outcome Of Board Meeting Held On 30Th October, 2026').status).toBe('ambiguous');
    expect(classifyAnnouncement('Board Meeting Intimation for Notice Of The Board Meeting').status).toBe('ambiguous');
    expect(classifyAnnouncement('Announcement under Regulation 30 (LODR)-Allotment').status).toBe('ambiguous');
    // A board outcome that names its subject is not ambiguous.
    expect(classifyAnnouncement('Board Meeting Outcome for Unaudited Financial Results').category).toBe('results');
  });

  it('resolves an investor presentation that names the results', () => {
    expect(classifyAnnouncement('Investor Presentation on Q2 FY27 results').category).toBe('results');
  });

  it('reports no_match rather than guessing', () => {
    expect(classifyAnnouncement('Intimation under Regulation 30')).toMatchObject({ category: 'unclassified', status: 'no_match', ruleIds: [] });
  });

  it('is deterministic and does not mutate input', () => {
    const title = 'Allotment of Commercial Paper';
    expect(classifyAnnouncement(title)).toEqual(classifyAnnouncement(title));
    expect(title).toBe('Allotment of Commercial Paper');
  });
});
