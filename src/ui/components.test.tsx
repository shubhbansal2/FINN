import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { isActive } from './AppShell';
import { Citation } from './Citation';
import type { Evidence } from './evidence';
import { CommandPalette, filterCommands, type Command } from './CommandPalette';
import { ComparisonTable } from './ComparisonTable';
import { ConfirmDialog } from './ConfirmDialog';
import { Delta } from './Delta';
import { Metric, MetricGroup } from './Metric';
import { PeriodSelector } from './PeriodSelector';
import { PriorityIndicator } from './PriorityIndicator';

describe('Delta', () => {
  it('states direction in text, not only colour', () => {
    render(<Delta delta={{ kind: 'ratio', value: -0.0625 }} basis="1D" />);
    expect(screen.getByText('down 6.3% 1D')).toBeInTheDocument();
  });

  it('treats a change that rounds to zero as unchanged', () => {
    render(<Delta delta={{ kind: 'ratio', value: 0.0004 }} basis="QoQ" />);
    expect(screen.getByText('unchanged QoQ')).toBeInTheDocument();
  });

  it('distinguishes not meaningful from missing', () => {
    const { rerender } = render(<Delta delta={{ kind: 'not_meaningful' }} basis="YoY" />);
    expect(screen.getByText('YoY change not meaningful')).toBeInTheDocument();
    rerender(<Delta delta={{ kind: 'missing' }} basis="YoY" />);
    expect(screen.getByText('YoY change not available')).toBeInTheDocument();
  });
});

describe('Metric', () => {
  it('renders a missing value with its reason, never as zero', () => {
    render(
      <MetricGroup label="test">
        <Metric label="EBITDA" value={{ kind: 'missing', reason: 'not_applicable' }} />
      </MetricGroup>,
    );
    expect(screen.getByText('Not applicable')).toBeInTheDocument();
    expect(screen.queryByText(/₹0/)).not.toBeInTheDocument();
  });

  it('labels derived figures', () => {
    render(
      <MetricGroup label="test">
        <Metric label="EBITDA margin" value={{ kind: 'percent', ratio: 0.2 }} derived={{ formula: 'EBITDA ÷ revenue.' }} />
      </MetricGroup>,
    );
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    expect(screen.getByText('Derived')).toBeInTheDocument();
  });
});

describe('ComparisonTable', () => {
  it('uses row and column headers and announces missing cells', () => {
    render(
      <ComparisonTable
        caption="Results"
        rowHeader="Line item"
        columns={[
          { id: 'a', label: 'Q2' },
          { id: 'b', label: 'Q1' },
        ]}
        rows={[
          {
            id: 'rev',
            label: 'Revenue',
            cells: [
              { kind: 'value', value: { kind: 'currency', valueInr: 1240e7 } },
              { kind: 'value', value: { kind: 'missing', reason: 'not_reported' } },
            ],
          },
        ]}
      />,
    );
    const region = screen.getByRole('region', { name: 'Results' });
    expect(region).toHaveAttribute('tabindex', '0');
    const row = screen.getByRole('row', { name: /Revenue/ });
    expect(within(row).getByRole('rowheader')).toHaveTextContent('Revenue');
    expect(within(row).getByText('₹1,240 Cr')).toBeInTheDocument();
    expect(within(row).getByText('Not reported')).toBeInTheDocument();
  });
});

describe('PriorityIndicator', () => {
  it('names the priority for assistive tech', () => {
    render(<PriorityIndicator priority="high" />);
    expect(screen.getByText('High priority')).toBeInTheDocument();
  });
});

function ControlledSelector({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState('24h');
  return (
    <PeriodSelector
      label="Window"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      options={[
        { value: '24h', label: '24h' },
        { value: '3d', label: '3d' },
        { value: 'custom', label: 'Custom', disabled: true },
        { value: '7d', label: '7d' },
      ]}
    />
  );
}

describe('PeriodSelector', () => {
  it('exposes a radio group with one tab stop', () => {
    render(<ControlledSelector />);
    const group = screen.getByRole('radiogroup', { name: 'Window' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: '24h' })).toHaveAttribute('aria-checked', 'true');
  });

  it('moves selection with arrow keys, skips disabled options and wraps', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledSelector onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: '24h' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '3d' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '7d' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '24h' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('7d');
  });
});

describe('CommandPalette', () => {
  const commands: Command[] = [
    { id: '1', label: 'Brief', group: 'Go to', perform: vi.fn() },
    { id: '2', label: 'Specimen Industries', hint: 'SPECIMEN', group: 'Companies', perform: vi.fn() },
  ];

  it('filters on label, hint and keywords', () => {
    expect(filterCommands(commands, 'spec').map((c) => c.id)).toEqual(['2']);
    expect(filterCommands(commands, '  ').map((c) => c.id)).toEqual(['1', '2']);
    expect(filterCommands(commands, 'zzz')).toEqual([]);
  });

  it('runs the active command on Enter and closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const perform = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={[{ id: 'a', label: 'Alpha', group: 'G', perform }, { id: 'b', label: 'Beta', group: 'G', perform: vi.fn() }]}
      />,
    );
    const input = screen.getByRole('combobox');
    await user.type(input, 'alp');
    await user.keyboard('{Enter}');
    expect(perform).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />);
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByText('Nothing matches “zzz”.')).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('focuses Cancel first and blocks actions while busy', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmDialog open title="Delete?" consequence="Cannot be undone." confirmLabel="Delete" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    rerender(
      <ConfirmDialog open busy title="Delete?" consequence="Cannot be undone." confirmLabel="Delete" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Delete/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('shows the error inline and stays open', () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        consequence="Cannot be undone."
        confirmLabel="Delete"
        error="Storage unavailable."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable.');
  });

  it('does not report a cancel when the parent closes it after confirming', () => {
    const onCancel = vi.fn();
    const props = { title: 'Delete?', consequence: 'x', confirmLabel: 'Delete', onConfirm: vi.fn(), onCancel };
    const { rerender } = render(<ConfirmDialog open {...props} />);
    rerender(<ConfirmDialog open={false} {...props} />);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('Citation', () => {
  const evidence: Evidence = {
    documentTitle: 'Results filing',
    documentKind: 'Results filing',
    page: 3,
    passageText: 'Profit before tax 176.0 | 165.0',
    quote: 'Profit before tax 176.0',
    extractionMethod: 'test',
    verification: 'verified',
    dataMode: 'demo',
  };

  it('can sit inside a paragraph: its dialog is portalled out of the text', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <p>
        Claim <Citation evidence={evidence} label="p.3" />
      </p>,
    );
    expect(container.querySelector('p dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: /p\.3/ }));
    const dialog = document.body.querySelector(':scope > dialog[open]');
    expect(dialog).not.toBeNull();
    expect(within(dialog as HTMLElement).getByText('Profit before tax 176.0').tagName).toBe('MARK');
  });
});

describe('isActive', () => {
  it('matches the Brief only at the root and sections by prefix', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/research', '/')).toBe(false);
    expect(isActive('/research/INFY', '/research')).toBe(true);
    expect(isActive('/researchers', '/research')).toBe(false);
  });
});
