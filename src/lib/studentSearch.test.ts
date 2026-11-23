import test from 'node:test';
import assert from 'node:assert/strict';
import type { Kelas, Student } from '../types';
import { formatStudentOptionLabel, searchStudentsForAutocomplete } from './studentSearch';

const sampleKelas: Kelas[] = [
  { id: 1, jurusan_id: 1, tingkat: 'X', nama: 'X TKJ 1', shift: 'PAGI' },
  { id: 2, jurusan_id: 2, tingkat: 'XII', nama: 'XII RPL 2', shift: 'SIANG' },
];

function makeStudent(id: number, overrides: Partial<Student> = {}): Student {
  return {
    id,
    nis: `10${id}`,
    nisn: `008100${String(id).padStart(4, '0')}`,
    nama: `Siswa Uji ${id}`,
    nickname: `Uji${id}`,
    kelas_id: 1,
    tanggal_lahir: '2008-05-01',
    status: 'AKTIF',
    embedding: null,
    embedding_quality_score: 0,
    embedding_updated_at: null,
    foto_ref: null,
    wa_ortu: '',
    created_at: '2026-01-01 07:00:00',
    ...overrides,
  };
}

test('exact NISN match ranks first ahead of partial name matches', () => {
  const students = [
    makeStudent(1, { nama: 'Budi Santoso', nisn: '0081000001' }),
    makeStudent(2, { nama: 'Andi Wijaya', nisn: '0099988776', kelas_id: 2 }),
    makeStudent(3, { nama: '0099988776 Putra', nisn: '0081000003' }),
  ];
  const results = searchStudentsForAutocomplete(students, sampleKelas, '0099988776');
  assert.equal(results.length, 2);
  assert.equal(results[0].student.id, 2);
  assert.equal(results[0].kelasNama, 'XII RPL 2');
});

test('multi-token search filters across nama and kelas simultaneously', () => {
  const students = [
    makeStudent(1, { nama: 'Siti Rahma', kelas_id: 1 }),
    makeStudent(2, { nama: 'Siti Rahma', kelas_id: 2 }),
  ];
  const results = searchStudentsForAutocomplete(students, sampleKelas, 'siti rpl');
  assert.equal(results.length, 1);
  assert.equal(results[0].student.id, 2);
  assert.equal(
    formatStudentOptionLabel(results[0].student, results[0].kelasNama),
    'Siti Rahma (0081000002 · XII RPL 2)'
  );
});

test('handles 5500 students fast and reaches students beyond index 200', () => {
  const students: Student[] = [];
  for (let i = 1; i <= 5500; i++) {
    students.push(
      makeStudent(i, {
        nama: i === 4899 ? 'Zaskia Nurul Hidayah' : `Siswa Sekolah ${i}`,
        nisn: i === 4899 ? '0077654321' : `0080${String(i).padStart(6, '0')}`,
        kelas_id: i % 2 === 0 ? 2 : 1,
      })
    );
  }
  const t0 = performance.now();
  const byName = searchStudentsForAutocomplete(students, sampleKelas, 'zaskia nurul', 20);
  const byEmpty = searchStudentsForAutocomplete(students, sampleKelas, '', 20);
  const elapsed = performance.now() - t0;

  assert.equal(byName.length, 1);
  assert.equal(byName[0].student.id, 4899);
  assert.equal(byEmpty.length, 20);
  assert.ok(elapsed < 100, `Expected search <100ms, got ${elapsed.toFixed(1)}ms`);
});
