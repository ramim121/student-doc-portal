'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One control that searches and selects.
 *
 * The upload form previously paired a search box with a separate <select> for
 * both university and course: typing filtered one control while the value
 * lived in another, so it was possible to type a name and still submit
 * nothing. This collapses that into a single combobox.
 *
 * Deliberately not built on cmdk/popover: it has to work inside a scrolling
 * form on a phone, where a portalled popover fights the on-screen keyboard.
 */

export type SearchableOption = {
  id: string;
  label: string;
  /** Shown dimmed after the label, e.g. a course title or short code. */
  sublabel?: string;
  /** Right-aligned note, e.g. "12 resources". */
  hint?: string;
};

type Props = {
  options: SearchableOption[];
  value: string;
  onChange: (id: string) => void;
  /** Called as the user types, for server-side filtering. */
  onSearch?: (query: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Chips rendered above the field, for the most likely choices. */
  quickPicks?: SearchableOption[];
  quickPicksLabel?: string;
  /** Renders an "add" row so a missing entry can be proposed inline. */
  onCreate?: (query: string) => void;
  createLabel?: string;
  id?: string;
};

export function SearchableSelect({
  options,
  value,
  onChange,
  onSearch,
  placeholder = 'Search...',
  emptyMessage = 'No matches.',
  disabled = false,
  loading = false,
  quickPicks,
  quickPicksLabel = 'Quick picks for you',
  onCreate,
  createLabel = 'Add',
  id,
}: Props) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () =>
      options.find((option) => option.id === value) ??
      quickPicks?.find((option) => option.id === value),
    [options, quickPicks, value],
  );

  // Local filtering still applies when the caller also filters server-side, so
  // the list never looks stale while a request is in flight.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.sublabel?.toLowerCase().includes(needle),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  const commit = (option: SearchableOption) => {
    onChange(option.id);
    setQuery('');
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (visible.length ? (current + delta + visible.length) % visible.length : 0));
      return;
    }
    if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      const option = visible[active];
      if (option) commit(option);
      else if (onCreate && query.trim()) onCreate(query.trim());
      return;
    }
    if (event.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      {quickPicks && quickPicks.length > 0 && (
        <div className="mb-2">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{quickPicksLabel}</p>
          <div className="flex flex-wrap gap-1.5">
            {quickPicks.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                onClick={() => commit(option)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  option.id === value
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground hover:border-primary/40 hover:text-primary',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={cn(
          'flex h-11 w-full items-center gap-2 rounded-xl border border-border bg-background px-3 transition-all',
          open && 'border-primary ring-2 ring-primary/20',
          disabled && 'opacity-50',
        )}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          id={fieldId}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${fieldId}-listbox`}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          value={open ? query : selected?.label ?? ''}
          placeholder={selected ? selected.label : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            onSearch?.(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
        {selected && !loading && (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => {
              onChange('');
              setQuery('');
              inputRef.current?.focus();
            }}
            className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </div>

      {open && !disabled && (
        <ul
          id={`${fieldId}-listbox`}
          role="listbox"
          className="absolute z-50 mt-1.5 max-h-64 w-full overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-1 shadow-lg"
        >
          {visible.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={option.id === value}
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(option)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  index === active ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {option.label}
                  {option.sublabel && (
                    <span className="ml-1.5 text-xs text-muted-foreground">{option.sublabel}</span>
                  )}
                </span>
                {option.hint && (
                  <span className="shrink-0 text-xs text-muted-foreground">{option.hint}</span>
                )}
                {option.id === value && <Check className="h-4 w-4 shrink-0" />}
              </button>
            </li>
          ))}

          {!visible.length && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {loading ? 'Searching...' : emptyMessage}
            </li>
          )}

          {onCreate && query.trim().length > 1 && (
            <li className="border-t border-border/60 pt-1">
              <button
                type="button"
                onClick={() => {
                  onCreate(query.trim());
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-primary hover:bg-primary/10"
              >
                <Plus className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {createLabel} &ldquo;{query.trim()}&rdquo;
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
