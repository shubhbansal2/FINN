'use client';

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Dialog } from './Dialog';
import { Icon } from './Icon';
import styles from './CommandPalette.module.css';

export type Command = {
  id: string;
  label: string;
  group: string;
  /** Right-aligned hint, e.g. a ticker or route. */
  hint?: string;
  keywords?: string[];
  perform: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  placeholder?: string;
};

export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) =>
    [c.label, c.hint ?? '', ...(c.keywords ?? [])].some((field) => field.toLowerCase().includes(q)),
  );
}

/**
 * Keyboard-first navigation (Ctrl/⌘ K or "/"). ARIA combobox + listbox: focus
 * stays in the input; arrows move the active option; Enter runs it.
 */
export function CommandPalette({ open, onClose, commands, placeholder = 'Go to…' }: CommandPaletteProps) {
  const titleId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const groups = useMemo(() => {
    const map = new Map<string, { command: Command; index: number }[]>();
    results.forEach((command, index) => {
      const list = map.get(command.group) ?? [];
      list.push({ command, index });
      map.set(command.group, list);
    });
    return [...map.entries()];
  }, [results]);

  const close = () => {
    setQuery('');
    setActive(0);
    onClose();
  };

  const run = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.perform();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[active]);
    }
  };

  const optionId = (index: number) => `${listId}-opt-${index}`;
  const activeCommand = results[active];

  return (
    <Dialog open={open} onClose={close} variant="palette" labelledBy={titleId} initialFocusRef={inputRef}>
      <h2 id={titleId} className="visually-hidden">
        Search and navigate
      </h2>
      <div className={styles.field}>
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeCommand ? optionId(active) : undefined}
          aria-label="Search commands"
          placeholder={placeholder}
          value={query}
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className={styles.kbd}>Esc</kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Results" className={styles.list}>
        {results.length === 0 ? (
          <p className={styles.empty} role="status">
            Nothing matches “{query.trim()}”.
          </p>
        ) : (
          groups.map(([group, items]) => (
            <div key={group} role="group" aria-label={group}>
              <p className={styles.group} aria-hidden="true">
                {group}
              </p>
              {items.map(({ command, index }) => (
                <div
                  key={command.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  className={styles.option}
                  onMouseMove={() => setActive(index)}
                  onClick={() => run(command)}
                >
                  <span>{command.label}</span>
                  {command.hint ? <span className={styles.hint}>{command.hint}</span> : null}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
