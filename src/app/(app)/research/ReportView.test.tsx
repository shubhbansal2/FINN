import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ResearchReportSchema, type ResearchReport, type StatementView } from '@/research/report';

import { ReportView } from './ReportView';

const unavailable = { status: 'unavailable' as const, note: 'Not available in this test.', data: null };

const evidence = (id: string, over: Partial<ResearchReport['evidence'][string]> = {}): ResearchReport['evidence'][string] => ({
  id,
  documentId: 'd',
  documentTitle: 'Q2 FY27 results',
  documentKind: 'Results filing',
  publishedAt: '2026-10-17T12:00:00.000Z',
  origin: 'exchange_filed',
  page: 3,
  locationLabel: 'p. 3',
  passage: 'Profit After Tax 131 124',
  quote: 'Profit After Tax 131 124',
  url: null,
  verification: 'verified',
  basis: 'arithmetic',
  reported: null,
  extraction: 'rule_parser',
  ...over,
});

const statement = (id: string, verdict: StatementView['evaluation']['verdict'], over: Partial<StatementView> = {}): StatementView => ({
  id,
  callLabel: 'Earnings call transcript, Q1 FY27',
  quote: 'We expect EBITDA margin of 18 to 20 percent for FY27.',
  speaker: 'A. Kumar',
  subject: 'ebitda_margin',
  nature: 'quantitative',
  target: { low: 18, high: 20, unit: 'percent' },
  horizonText: 'FY27',
  horizonPeriod: 'Q2 FY27',
  evidenceId: 'chunk:call',
  method: 'rules',
  evaluation: { verdict, reason: 'consolidated EBITDA margin for Q2 FY27 was 18.7% against 18–20%.', actualPercent: 18.7, variancePp: 0, method: 'margin.v1', actualVerified: true, actualEvidenceIds: ['fact:ok'] },
  ...over,
});

function report(over: Partial<ResearchReport['modules']> = {}): ResearchReport {
  return ResearchReportSchema.parse({
    engineVersion: 'test',
    generatedAt: '2026-11-01T06:00:00.000Z',
    dataMode: 'fixture',
    status: 'partial',
    company: { id: 'nse:specimen', name: 'Specimen Industries', nseSymbol: 'SPECIMEN', bseCode: null, role: 'research' },
    request: { ticker: 'SPECIMEN', question: null, period: null },
    sources: [],
    evidence: {
      'fact:ok': evidence('fact:ok', { reported: { printed: '1,31,045', scale: 'crore', normalizedInr: 1_310_450_000_000, period: 'Q2 FY27', basis: 'consolidated' } }),
      'chunk:call': evidence('chunk:call', { documentKind: 'Concall transcript', documentTitle: 'Earnings call transcript, Q1 FY27', basis: 'quote', passage: 'We expect EBITDA margin of 18 to 20 percent for FY27.', quote: 'We expect EBITDA margin of 18 to 20 percent for FY27.' }),
    },
    modules: {
      snapshot: unavailable,
      trajectory: unavailable,
      balanceSheet: unavailable,
      guidance: unavailable,
      scorecard: unavailable,
      narrative: unavailable,
      bullBear: {
        status: 'partial',
        note: 'Computed observations.',
        data: {
          mode: 'computed',
          bull: [{ text: 'Consolidated PAT +17.0% YoY in Q2 FY27.', kind: 'computed', evidenceIds: ['fact:ok', 'fact:missing'] }],
          bear: [],
        },
      },
      question: unavailable,
      ...over,
    },
    diagnostics: [],
    model: { configured: false, description: 'none', calls: [] },
  });
}

const expand = (title: RegExp) => fireEvent.click(screen.getByRole('button', { name: title }));

describe('ReportView', () => {
  it('marks an unresolvable citation as unavailable instead of hiding it', () => {
    render(<ReportView report={report()} cached={false} />);
    expand(/Bull and bear case/);
    expect(screen.getByRole('button', { name: /Results, p\. 3/ })).toBeInTheDocument();
    expect(screen.getByText('Source unavailable')).toBeInTheDocument();
  });

  it('labels demo data and partial status, and reduces unavailable modules to one explained line', () => {
    render(<ReportView report={report()} cached={false} />);
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0);
    expect(screen.getByText(/Partial research/)).toBeInTheDocument();
    const unavailableSections = screen.getAllByRole('region', { name: /not available/ });
    expect(unavailableSections.length).toBeGreaterThanOrEqual(4);
    expect(within(screen.getByRole('region', { name: 'Financial trajectory: not available' })).getByText('Not available in this test.')).toBeInTheDocument();
    expect(screen.getByText('No supported points.')).toBeInTheDocument();
  });

  it('keeps later sections collapsed on a narrow screen with a summary line, and expands on request', () => {
    render(<ReportView report={report()} cached={false} />);
    const toggle = screen.getByRole('button', { name: /Bull and bear case/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('1 bull · 0 bear')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('describes guidance outcomes in careful words, never as a tick or cross', () => {
    const statements = [
      statement('s1', 'met'),
      statement('s2', 'awaiting_results', { quote: 'Revenue growth of 15% in FY28.', subject: 'revenue_growth', target: { low: 15, high: 15, unit: 'percent' }, evaluation: { verdict: 'awaiting_results', reason: 'FY28 has not been reported yet.', actualPercent: null, variancePp: null, method: null, actualVerified: null, actualEvidenceIds: [] } }),
    ];
    render(
      <ReportView
        report={report({
          guidance: { status: 'ok', note: null, data: { statements } },
          scorecard: { status: 'ok', note: null, data: { calls: [{ callLabel: 'Q1 FY27 call', documentId: 'd', statementIds: ['s1', 's2'], inferredQuarter: null }], counts: {} } },
        })}
        cached={false}
      />,
    );
    expand(/Narrative vs numbers/);
    expect(screen.getByText('Within the stated range')).toBeInTheDocument();
    expect(screen.getByText('Not yet reported')).toBeInTheDocument();
    expect(screen.queryByText(/✓|✗/)).not.toBeInTheDocument();
    expect(screen.getAllByText('18–20%').length).toBeGreaterThan(0);
  });

  it('shows the printed value, stated unit and normalised value in the evidence panel', () => {
    render(<ReportView report={report()} cached={false} />);
    expand(/Bull and bear case/);
    fireEvent.click(screen.getByRole('button', { name: /Results, p\. 3/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('1,31,045')).toBeInTheDocument();
    expect(within(dialog).getByText('₹ crore')).toBeInTheDocument();
    expect(within(dialog).getByText(/₹1,31,045 Cr = ₹13,10,45,00,00,000/)).toBeInTheDocument();
    expect(within(dialog).getByText('Computed by FINN')).toBeInTheDocument();
  });
});
