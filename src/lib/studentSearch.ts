import type { Kelas, Student } from '../types';

export interface StudentAutocompleteItem {
  student: Student;
  kelasNama: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function computeStudentMatchRank(
  student: Student,
  kelasNamaLower: string,
  tokens: string[],
  rawQuery: string
): number | null {
  const nisnLower = student.nisn.toLowerCase();
  const nisLower = student.nis.toLowerCase();
  const namaLower = student.nama.toLowerCase();
  const nicknameLower = (student.nickname || '').toLowerCase();

  for (const token of tokens) {
    const matched =
      namaLower.includes(token) ||
      nisnLower.includes(token) ||
      nisLower.includes(token) ||
      nicknameLower.includes(token) ||
      kelasNamaLower.includes(token);
    if (!matched) return null;
  }

  if (nisnLower === rawQuery || nisLower === rawQuery) return 0;
  if (nisnLower.startsWith(rawQuery) || nisLower.startsWith(rawQuery)) return 1;
  if (namaLower === rawQuery) return 2;
  if (namaLower.startsWith(rawQuery)) return 3;

  const words = namaLower.split(/\s+/);
  if (words.some((w) => w.startsWith(rawQuery))) return 4;
  if (nicknameLower && nicknameLower.startsWith(rawQuery)) return 5;
  if (kelasNamaLower.startsWith(rawQuery)) return 6;
  return 7;
}

export function searchStudentsForAutocomplete(
  students: Student[],
  kelasList: Kelas[],
  query: string,
  limit = DEFAULT_LIMIT
): StudentAutocompleteItem[] {
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit || DEFAULT_LIMIT)));
  const kelasMap = new Map<number, string>();
  for (const k of kelasList) {
    kelasMap.set(k.id, k.nama);
  }

  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    const out: StudentAutocompleteItem[] = [];
    const count = Math.min(safeLimit, students.length);
    for (let i = 0; i < count; i++) {
      const s = students[i];
      out.push({ student: s, kelasNama: kelasMap.get(s.kelas_id) ?? '-' });
    }
    return out;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const scored: Array<{ rank: number; item: StudentAutocompleteItem }> = [];

  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    const kelasNama = kelasMap.get(s.kelas_id) ?? '-';
    const rank = computeStudentMatchRank(s, kelasNama.toLowerCase(), tokens, normalized);
    if (rank !== null) {
      scored.push({ rank, item: { student: s, kelasNama } });
    }
  }

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.item.student.nama.localeCompare(b.item.student.nama, 'id');
  });

  return scored.slice(0, safeLimit).map((entry) => entry.item);
}

export function formatStudentOptionLabel(student: Student, kelasNama: string): string {
  return `${student.nama} (${student.nisn} · ${kelasNama})`;
}
