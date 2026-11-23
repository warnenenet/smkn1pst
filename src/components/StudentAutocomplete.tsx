import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Kelas, Student } from '../types';
import { formatStudentOptionLabel, searchStudentsForAutocomplete } from '../lib/studentSearch';

export interface ExtraAutocompleteOption {
  value: string;
  label: string;
  meta?: string;
}

interface StudentAutocompleteProps {
  id: string;
  students: Student[];
  kelasList: Kelas[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxSuggestions?: number;
  extraOptions?: ExtraAutocompleteOption[];
  emptyMessage?: string;
}

type DropdownEntry =
  | { kind: 'student'; value: string; student: Student; kelasNama: string }
  | { kind: 'extra'; value: string; label: string; meta?: string };

export const StudentAutocomplete: React.FC<StudentAutocompleteProps> = ({
  id,
  students,
  kelasList,
  value,
  onChange,
  placeholder = 'Ketik nama, NISN, atau kelas...',
  maxSuggestions = 20,
  extraOptions = [],
  emptyMessage = 'Siswa tidak ditemukan.',
}) => {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const kelasMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const k of kelasList) map.set(k.id, k.nama);
    return map;
  }, [kelasList]);

  const selectedLabel = useMemo(() => {
    if (!value) return '';
    const extra = extraOptions.find((o) => o.value === value);
    if (extra) return extra.label;
    const found = students.find((s) => String(s.id) === value);
    if (!found) return '';
    return formatStudentOptionLabel(found, kelasMap.get(found.kelas_id) ?? '-');
  }, [value, extraOptions, students, kelasMap]);

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState(selectedLabel);
  const [isTyping, setIsTyping] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!isTyping) {
      setQuery(selectedLabel);
    }
  }, [selectedLabel, isTyping]);

  useEffect(() => {
    const handleClickOutside = (ev: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) {
        setIsOpen(false);
        setIsTyping(false);
        setQuery(selectedLabel);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [selectedLabel]);

  const effectiveQuery = isTyping ? query : '';

  const entries: DropdownEntry[] = useMemo(() => {
    const qLower = effectiveQuery.trim().toLowerCase();
    const matchedExtras: DropdownEntry[] = extraOptions
      .filter(
        (opt) =>
          !qLower ||
          opt.label.toLowerCase().includes(qLower) ||
          (opt.meta ?? '').toLowerCase().includes(qLower)
      )
      .map((opt) => ({ kind: 'extra', value: opt.value, label: opt.label, meta: opt.meta }));

    const matchedStudents: DropdownEntry[] = searchStudentsForAutocomplete(
      students,
      kelasList,
      effectiveQuery,
      maxSuggestions
    ).map((item) => ({
      kind: 'student',
      value: String(item.student.id),
      student: item.student,
      kelasNama: item.kelasNama,
    }));

    return [...matchedExtras, ...matchedStudents];
  }, [effectiveQuery, extraOptions, students, kelasList, maxSuggestions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [entries.length, effectiveQuery]);

  const selectEntry = (entry: DropdownEntry) => {
    onChange(entry.value);
    const nextText =
      entry.kind === 'extra'
        ? entry.label
        : formatStudentOptionLabel(entry.student, entry.kelasNama);
    setQuery(nextText);
    setIsTyping(false);
    setIsOpen(false);
  };

  const handleClear = () => {
    onChange('');
    setQuery('');
    setIsTyping(true);
    setIsOpen(true);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        return;
      }
      setActiveIndex((prev) => (entries.length > 0 ? (prev + 1) % entries.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        return;
      }
      setActiveIndex((prev) => (entries.length > 0 ? (prev - 1 + entries.length) % entries.length : 0));
    } else if (e.key === 'Enter' && isOpen) {
      if (entries[activeIndex]) {
        e.preventDefault();
        selectEntry(entries[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setIsTyping(false);
      setQuery(selectedLabel);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative flex items-center">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={isOpen && entries[activeIndex] ? `${listboxId}-opt-${activeIndex}` : undefined}
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          onFocus={() => {
            setIsOpen(true);
            if (value && query === selectedLabel) {
              setQuery('');
              setIsTyping(true);
            }
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsTyping(true);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="w-full border border-slate-300 rounded-md pl-8 pr-8 py-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        {(query || value) && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Bersihkan pilihan siswa"
            title="Cari siswa lain"
            className="absolute right-2 p-0.5 text-slate-400 hover:text-slate-700 rounded"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-40 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-slate-300 rounded-md shadow-lg divide-y divide-slate-100 text-xs"
        >
          {entries.length === 0 ? (
            <li className="px-3 py-2.5 text-slate-500">{emptyMessage}</li>
          ) : (
            entries.map((entry, idx) => {
              const isHighlighted = idx === activeIndex;
              const isSelected = entry.value === value;
              return (
                <li
                  key={`${entry.kind}-${entry.value}`}
                  id={`${listboxId}-opt-${idx}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectEntry(entry);
                  }}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`px-3 py-2 cursor-pointer flex items-center justify-between gap-2 ${
                    isHighlighted
                      ? 'bg-blue-50 text-blue-900'
                      : isSelected
                        ? 'bg-slate-50 text-slate-900 font-medium'
                        : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {entry.kind === 'extra' ? (
                    <>
                      <span className="font-medium text-amber-800">{entry.label}</span>
                      {entry.meta && <span className="text-[11px] text-slate-500 shrink-0">{entry.meta}</span>}
                    </>
                  ) : (
                    <>
                      <div className="min-w-0">
                        <div className="font-medium truncate">{entry.student.nama}</div>
                        <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                          NISN {entry.student.nisn} · NIS {entry.student.nis || '-'}
                        </div>
                      </div>
                      <span className="shrink-0 px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-medium">
                        {entry.kelasNama}
                      </span>
                    </>
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
};
