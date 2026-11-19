import React, { useState } from 'react';
import { Upload, GitCompare, Trash2, UserPlus, FileSpreadsheet, Download, Layers, ZoomIn } from 'lucide-react';
import type { AcademicTransitionType, AppDatabase, Student, StudentStatus } from '../types';
import { FaceLightboxModal, type FaceGalleryItem } from './FaceLightboxModal';

export interface ExcelTransitionItem {
  nisn: string;
  nama: string;
  oldKelas: string;
  newKelas: string;
  transition: AcademicTransitionType;
}

export interface ExcelImportResult {
  ok: boolean;
  total: number;
  imported: number;
  updated: number;
  skipped: number;
  promoted?: number;
  retained?: number;
  transferred?: number;
  graduated?: number;
  createdClasses: string[];
  transitions?: ExcelTransitionItem[];
  errors: string[];
}

interface StudentsViewProps {
  db: AppDatabase;
  onAddStudent: (payload: {
    nis: string;
    nisn: string;
    nama: string;
    nickname: string;
    kelas_id: number;
    tanggal_lahir: string;
    status: StudentStatus;
    wa_ortu: string;
  }) => Promise<void>;
  onDeleteStudent: (id: number) => Promise<void>;
  onEnrollSingle: (id: number, photoDataUrl?: string) => Promise<void>;
  onEnrollBatch: (entries: Array<{ filename: string; photoDataUrl?: string }>) => Promise<string>;
  onImportExcel: (payload: {
    fileBase64: string;
    filename: string;
    updateExisting: boolean;
    markMissingGraduated: boolean;
  }) => Promise<ExcelImportResult>;
  onAddJurusan: (payload: { kode: string; nama: string }) => Promise<void>;
  onDeleteJurusan: (id: number) => Promise<void>;
  onAddKelas: (payload: { jurusan_id: number; tingkat: string; nama: string; shift: 'PAGI' | 'SIANG' | 'NONE' }) => Promise<void>;
  onDeleteKelas: (id: number) => Promise<void>;
  onCompareFace: (
    p1: { name: string; size: number; photoDataUrl?: string },
    p2: { name: string; size: number; photoDataUrl?: string }
  ) => Promise<{
    similarity: number;
    threshold: number;
    match: boolean;
    status: string;
  }>;
}

export const StudentsView: React.FC<StudentsViewProps> = ({
  db,
  onAddStudent,
  onDeleteStudent,
  onEnrollSingle,
  onEnrollBatch,
  onImportExcel,
  onAddJurusan,
  onDeleteJurusan,
  onAddKelas,
  onDeleteKelas,
  onCompareFace,
}) => {
  const [subTab, setSubTab] = useState<'list' | 'jurusan' | 'compare'>('list');
  const [search, setSearch] = useState('');
  const [kelasFilter, setKelasFilter] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [batchMsg, setBatchMsg] = useState('');
  const [updateExisting, setUpdateExisting] = useState(true);
  const [markMissingGraduated, setMarkMissingGraduated] = useState(false);
  const [excelLoading, setExcelLoading] = useState(false);
  const [excelResult, setExcelResult] = useState<ExcelImportResult | null>(null);

  // Jurusan & Kelas form states
  const [jurKode, setJurKode] = useState('');
  const [jurNama, setJurNama] = useState('');
  const [newKelasJurusanId, setNewKelasJurusanId] = useState(String(db.jurusans[0]?.id ?? 1));
  const [newKelasTingkat, setNewKelasTingkat] = useState('X');
  const [newKelasNama, setNewKelasNama] = useState('');
  const [newKelasShift, setNewKelasShift] = useState<'PAGI' | 'SIANG' | 'NONE'>('PAGI');

  // Form add student
  const [nis, setNis] = useState('');
  const [nisn, setNisn] = useState('');
  const [nama, setNama] = useState('');
  const [nickname, setNickname] = useState('');
  const [kelasId, setKelasId] = useState(String(db.kelas[0]?.id ?? 1));
  const [tglLahir, setTglLahir] = useState('2008-05-01');
  const [status, setStatus] = useState<StudentStatus>('AKTIF');
  const [waOrtu, setWaOrtu] = useState('');

  // Compare face
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [compareResult, setCompareResult] = useState<{
    similarity: number;
    threshold: number;
    match: boolean;
    status: string;
  } | null>(null);
  const [lightboxState, setLightboxState] = useState<{
    title: string;
    subtitle: string;
    referenceItem: FaceGalleryItem | null;
    items: FaceGalleryItem[];
    initialIndex: number;
  } | null>(null);

  const openStudentGallery = (s: Student) => {
    const kelas = db.kelas.find((k) => k.id === s.kelas_id);
    const historyPhotos: FaceGalleryItem[] = db.face_update_history
      .filter((h) => h.student_id === s.id && Boolean(h.snapshot_path))
      .sort((a, b) => b.version - a.version)
      .map((h) => ({
        src: h.snapshot_path,
        label: h.is_canonical ? `Versi #${h.version} (Kanonik)` : `Versi #${h.version}`,
        qualityScore: h.quality_score,
        timestamp: h.created_at,
      }));
    const hitPhotos: FaceGalleryItem[] = db.attendance_logs
      .filter((l) => l.student_id === s.id && Boolean(l.snapshot_path))
      .slice(0, 12)
      .map((l) => ({
        src: String(l.snapshot_path),
        label: `Hit ${l.tipe} (${l.status})`,
        similarity: l.similarity_score ?? null,
        timestamp: l.timestamp.replace('T', ' '),
        cameraName: db.cameras.find((cm) => cm.id === l.camera_id)?.nama_kamera ?? null,
      }));

    const items: FaceGalleryItem[] = [];
    if (s.foto_ref) {
      items.push({
        src: s.foto_ref,
        label: 'Foto Profil Utama',
        qualityScore: s.embedding_quality_score || null,
        timestamp: s.embedding_updated_at ?? null,
      });
    }
    for (const item of [...hitPhotos, ...historyPhotos]) {
      if (!items.some((x) => x.src === item.src && x.label === item.label)) {
        items.push(item);
      }
    }
    if (items.length === 0) return;

    setLightboxState({
      title: `Galeri Wajah & Hit Kamera — ${s.nama}`,
      subtitle: `${kelas?.nama ?? '-'} · NISN ${s.nisn} · ${items.length} foto tersimpan`,
      referenceItem: s.foto_ref
        ? {
            src: s.foto_ref,
            label: 'Foto Profil Utama',
            meta: `Skor ${(s.embedding_quality_score || 0).toFixed(3)}`,
          }
        : null,
      items,
      initialIndex: 0,
    });
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await onAddStudent({
      nis,
      nisn,
      nama,
      nickname,
      kelas_id: Number(kelasId),
      tanggal_lahir: tglLahir,
      status,
      wa_ortu: waOrtu,
    });
    setNis('');
    setNisn('');
    setNama('');
    setNickname('');
    setWaOrtu('');
  };

  const handleSingleFile = (studentId: number, file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onEnrollSingle(studentId, typeof reader.result === 'string' ? reader.result : undefined);
    };
    reader.readAsDataURL(file);
  };

  const readAsDataUrl = (file: File): Promise<string | undefined> =>
    new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(file);
    });

  const handleBatchFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const entries: Array<{ filename: string; photoDataUrl?: string }> = [];
    for (const f of Array.from(files)) {
      const photoDataUrl = f.type.startsWith('image/') ? await readAsDataUrl(f) : undefined;
      entries.push({ filename: f.name, photoDataUrl });
    }
    const msg = await onEnrollBatch(entries);
    setBatchMsg(msg);
  };

  const handleExcelUpload = async (file: File | undefined) => {
    if (!file) return;
    setExcelLoading(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      if (!dataUrl) return;
      const result = await onImportExcel({
        fileBase64: dataUrl,
        filename: file.name,
        updateExisting,
        markMissingGraduated: updateExisting && markMissingGraduated,
      });
      setExcelResult(result);
    } catch {
      // Notifikasi error sudah ditangani oleh apiPost
    } finally {
      setExcelLoading(false);
    }
  };

  const handleCompare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file1 || !file2) return;
    const [photo1DataUrl, photo2DataUrl] = await Promise.all([readAsDataUrl(file1), readAsDataUrl(file2)]);
    const res = await onCompareFace(
      { name: file1.name, size: file1.size, photoDataUrl: photo1DataUrl },
      { name: file2.name, size: file2.size, photoDataUrl: photo2DataUrl }
    );
    setCompareResult(res);
  };

  const filtered = db.students.filter((s) => {
    if (kelasFilter && String(s.kelas_id) !== kelasFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return s.nama.toLowerCase().includes(q) || s.nisn.toLowerCase().includes(q) || s.nis.toLowerCase().includes(q);
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedStudents = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setSubTab('list')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            subTab === 'list' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Daftar Siswa &amp; Enrollment
        </button>
        <button
          type="button"
          onClick={() => setSubTab('jurusan')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            subTab === 'jurusan' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Jurusan &amp; Kelas ({db.jurusans.length}/{db.kelas.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab('compare')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            subTab === 'compare' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Compare Face (2 Foto)
        </button>
      </div>

      {subTab === 'jurusan' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-700" />
              <h2 className="text-sm font-semibold text-slate-900">Kelola Jurusan (Tambah / Hapus)</h2>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await onAddJurusan({ kode: jurKode, nama: jurNama });
                  setJurKode('');
                  setJurNama('');
                } catch {
                  // error toast handled by apiPost
                }
              }}
              className="flex flex-wrap gap-2"
            >
              <input
                placeholder="Kode (mis. TKR)"
                value={jurKode}
                onChange={(e) => setJurKode(e.target.value)}
                required
                className="w-28 border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono uppercase"
              />
              <input
                placeholder="Nama Jurusan Lengkap"
                value={jurNama}
                onChange={(e) => setJurNama(e.target.value)}
                required
                className="flex-1 border border-slate-300 rounded px-2.5 py-1.5 text-xs"
              />
              <button type="submit" className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded">
                Tambah Jurusan
              </button>
            </form>

            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-medium">Kode</th>
                  <th className="py-2 font-medium">Nama Jurusan</th>
                  <th className="py-2 font-medium">Kelas</th>
                  <th className="py-2 font-medium text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.jurusans.map((j) => {
                  const kelasCount = db.kelas.filter((k) => k.jurusan_id === j.id).length;
                  return (
                    <tr key={j.id}>
                      <td className="py-2 font-mono font-semibold text-slate-900">{j.kode}</td>
                      <td className="py-2 text-slate-700">{j.nama}</td>
                      <td className="py-2 font-mono text-slate-500">{kelasCount} rombel</td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => onDeleteJurusan(j.id).catch(() => {})}
                          aria-label={`Hapus jurusan ${j.kode}`}
                          className="p-1 text-slate-400 hover:text-red-600 rounded"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">Kelola Rombel / Kelas</h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await onAddKelas({
                    jurusan_id: Number(newKelasJurusanId),
                    tingkat: newKelasTingkat,
                    nama: newKelasNama,
                    shift: newKelasShift,
                  });
                  setNewKelasNama('');
                } catch {
                  // error toast handled by apiPost
                }
              }}
              className="grid grid-cols-2 sm:grid-cols-4 gap-2"
            >
              <select
                value={newKelasJurusanId}
                onChange={(e) => setNewKelasJurusanId(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white"
              >
                {db.jurusans.map((j) => (
                  <option key={j.id} value={j.id}>{j.kode}</option>
                ))}
              </select>
              <select
                value={newKelasTingkat}
                onChange={(e) => setNewKelasTingkat(e.target.value)}
                className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white"
              >
                <option value="X">Tingkat X</option>
                <option value="XI">Tingkat XI</option>
                <option value="XII">Tingkat XII</option>
                <option value="XIII">Tingkat XIII</option>
              </select>
              <input
                placeholder="Nama (mis. X TKR 1)"
                value={newKelasNama}
                onChange={(e) => setNewKelasNama(e.target.value)}
                required
                className="border border-slate-300 rounded px-2.5 py-1.5 text-xs"
              />
              <div className="flex gap-1.5">
                <select
                  value={newKelasShift}
                  onChange={(e) => setNewKelasShift(e.target.value as 'PAGI' | 'SIANG' | 'NONE')}
                  className="border border-slate-300 rounded px-1.5 py-1.5 text-xs bg-white flex-1"
                >
                  <option value="PAGI">PAGI</option>
                  <option value="SIANG">SIANG</option>
                </select>
                <button type="submit" className="px-2.5 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded">
                  +
                </button>
              </div>
            </form>

            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-medium">Kelas</th>
                  <th className="py-2 font-medium">Jurusan</th>
                  <th className="py-2 font-medium">Shift</th>
                  <th className="py-2 font-medium">Siswa</th>
                  <th className="py-2 font-medium text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.kelas.map((k) => {
                  const jur = db.jurusans.find((j) => j.id === k.jurusan_id);
                  const count = db.students.filter((s) => s.kelas_id === k.id).length;
                  return (
                    <tr key={k.id}>
                      <td className="py-2 font-medium text-slate-900">{k.nama}</td>
                      <td className="py-2 font-mono text-slate-600">{jur?.kode ?? '-'}</td>
                      <td className="py-2 text-slate-600">{k.shift}</td>
                      <td className="py-2 font-mono text-slate-500">{count}</td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => onDeleteKelas(k.id).catch(() => {})}
                          aria-label={`Hapus kelas ${k.nama}`}
                          className="p-1 text-slate-400 hover:text-red-600 rounded"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>
      ) : subTab === 'compare' ? (
        <section className="bg-white border border-slate-200 rounded-lg p-6 max-w-xl">
          <div className="flex items-center gap-2 mb-4">
            <GitCompare className="w-4 h-4 text-blue-700" />
            <h2 className="text-sm font-semibold text-slate-900">Bandingkan Kemiripan 2 Foto Wajah (InsightFace 512-dim)</h2>
          </div>
          <form onSubmit={handleCompare} className="space-y-4">
            <div>
              <label htmlFor="cmp-p1" className="block text-xs font-medium text-slate-700 mb-1">Foto Wajah 1</label>
              <input id="cmp-p1" type="file" accept="image/*" required onChange={(e) => setFile1(e.target.files?.[0] ?? null)} className="text-xs" />
            </div>
            <div>
              <label htmlFor="cmp-p2" className="block text-xs font-medium text-slate-700 mb-1">Foto Wajah 2</label>
              <input id="cmp-p2" type="file" accept="image/*" required onChange={(e) => setFile2(e.target.files?.[0] ?? null)} className="text-xs" />
            </div>
            <button type="submit" className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md">
              Hitung Cosine Similarity
            </button>
          </form>
          {compareResult && (
            <div className="mt-5 p-4 border border-slate-200 rounded-md bg-slate-50">
              <div className={`text-sm font-bold ${compareResult.match ? 'text-emerald-700' : 'text-red-700'}`}>
                {compareResult.status}
              </div>
              <div className="text-xs text-slate-600 mt-1 font-mono tabular-nums">
                Cosine Similarity: <strong>{compareResult.similarity}</strong> · Threshold: {compareResult.threshold}
              </div>
            </div>
          )}
        </section>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white border border-slate-200 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <UserPlus className="w-4 h-4 text-blue-700" />
                <h2 className="text-sm font-semibold text-slate-900">Tambah Siswa Baru</h2>
              </div>
              <form onSubmit={handleCreate} className="grid grid-cols-2 gap-2.5">
                <input placeholder="NIS" value={nis} onChange={(e) => setNis(e.target.value)} required className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
                <input placeholder="NISN" value={nisn} onChange={(e) => setNisn(e.target.value)} required className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
                <input placeholder="Nama Lengkap" value={nama} onChange={(e) => setNama(e.target.value)} required className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
                <input placeholder="Panggilan TTS" value={nickname} onChange={(e) => setNickname(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
                <select value={kelasId} onChange={(e) => setKelasId(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white">
                  {db.kelas.map((k) => (
                    <option key={k.id} value={k.id}>{k.nama}</option>
                  ))}
                </select>
                <input type="date" value={tglLahir} onChange={(e) => setTglLahir(e.target.value)} required className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
                <select value={status} onChange={(e) => setStatus(e.target.value as StudentStatus)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white">
                  <option value="AKTIF">AKTIF</option>
                  <option value="PKL">PKL</option>
                  <option value="CUTI">CUTI</option>
                  <option value="IZIN_PANJANG">IZIN_PANJANG</option>
                  <option value="LULUS">LULUS</option>
                </select>
                <input placeholder="WA Ortu (628xxx)" value={waOrtu} onChange={(e) => setWaOrtu(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
                <button type="submit" className="col-span-2 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md">
                  Simpan Siswa
                </button>
              </form>
            </section>

            <section className="bg-white border border-slate-200 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <Upload className="w-4 h-4 text-emerald-700" />
                <h2 className="text-sm font-semibold text-slate-900">Enrollment Massal (Multi-Foto / Folder NISN)</h2>
              </div>
              <p className="text-xs text-slate-600 mb-3">
                Pilih beberapa file foto bernama <code className="font-mono bg-slate-100 px-1 rounded">NISN.jpg</code> (misal <code className="font-mono bg-slate-100 px-1 rounded">0081122006.jpg</code>) untuk mendaftarkan embedding wajah sekaligus.
              </p>
              <input
                type="file"
                multiple
                accept="image/*,.zip"
                aria-label="Pilih foto enrollment massal"
                onChange={(e) => handleBatchFiles(e.target.files)}
                className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100"
              />
              {batchMsg && <p className="mt-3 text-xs font-medium text-emerald-700">{batchMsg}</p>}
            </section>
          </div>

          <section className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-blue-700" />
                <h2 className="text-sm font-semibold text-slate-900">Import Data Siswa dari Excel (.xlsx / .xls / .csv)</h2>
              </div>
              <a
                href="/api/students/import-template"
                download="template_import_siswa.xlsx"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md"
              >
                <Download className="w-3.5 h-3.5" />
                Download Template (.xlsx)
              </a>
            </div>
            <p className="text-xs text-slate-600 mb-3">
              Kolom wajib: <code className="font-mono bg-slate-100 px-1 rounded">NIS</code>, <code className="font-mono bg-slate-100 px-1 rounded">NISN</code>, <code className="font-mono bg-slate-100 px-1 rounded">Nama</code>, <code className="font-mono bg-slate-100 px-1 rounded">Kelas</code>, <code className="font-mono bg-slate-100 px-1 rounded">Tanggal_Lahir</code>. Saat upload ulang Excel tahun ajaran baru, data lama dijadikan acuan untuk mendeteksi <strong>Naik Kelas / Tinggal Kelas</strong> dan <strong>foto wajah lama tetap dipertahankan</strong>.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                aria-label="Upload file Excel siswa"
                disabled={excelLoading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  handleExcelUpload(f);
                  e.target.value = '';
                }}
                className="block text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={updateExisting}
                  onChange={(e) => setUpdateExisting(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Perbarui data siswa jika NISN/NIS sudah ada (bandingkan kenaikan kelas)
              </label>
              {updateExisting && (
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={markMissingGraduated}
                    onChange={(e) => setMarkMissingGraduated(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  Tandai siswa XII yang tidak ada di Excel sebagai LULUS
                </label>
              )}
            </div>
            {excelLoading && <p className="mt-3 text-xs text-slate-500">Memproses file Excel...</p>}
            {excelResult && (
              <div className="mt-4 p-3.5 rounded-md border border-slate-200 bg-slate-50 text-xs space-y-2">
                <div className="font-semibold text-slate-900">
                  Hasil Import ({excelResult.total} baris):{' '}
                  <span className="text-emerald-700">{excelResult.imported} baru</span> ·{' '}
                  <span className="text-blue-700">{excelResult.promoted ?? 0} naik kelas</span> ·{' '}
                  <span className="text-amber-700">{excelResult.retained ?? 0} tinggal kelas</span> ·{' '}
                  <span className="text-indigo-700">{excelResult.transferred ?? 0} pindah kelas</span> ·{' '}
                  <span className="text-slate-700">{excelResult.graduated ?? 0} lulus</span> ·{' '}
                  <span className="text-red-700">{excelResult.skipped} dilewati</span>
                </div>
                {excelResult.createdClasses.length > 0 && (
                  <div className="text-slate-600">
                    Kelas otomatis dibuat: <span className="font-mono">{excelResult.createdClasses.join(', ')}</span>
                  </div>
                )}
                {excelResult.transitions && excelResult.transitions.length > 0 && (
                  <div className="max-h-36 overflow-y-auto border border-slate-200 rounded bg-white">
                    <table className="w-full text-left text-[11px]">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th className="px-2 py-1">Siswa</th>
                          <th className="px-2 py-1">Kelas Lama &rarr; Baru</th>
                          <th className="px-2 py-1 text-right">Status Kenaikan</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {excelResult.transitions.slice(0, 15).map((t, idx) => (
                          <tr key={idx}>
                            <td className="px-2 py-1 font-medium text-slate-800">{t.nama}</td>
                            <td className="px-2 py-1 font-mono text-slate-600">{t.oldKelas} &rarr; {t.newKelas}</td>
                            <td className="px-2 py-1 text-right font-semibold text-blue-700">{t.transition}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {excelResult.errors.length > 0 && (
                  <ul className="list-disc pl-5 text-red-700 space-y-0.5">
                    {excelResult.errors.slice(0, 5).map((err, idx) => (
                      <li key={idx}>{err}</li>
                    ))}
                    {excelResult.errors.length > 5 && (
                      <li>...dan {excelResult.errors.length - 5} baris catatan lainnya.</li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="text-sm font-semibold text-slate-900">Database Siswa ({filtered.length})</h2>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Filter kelas siswa"
                  value={kelasFilter}
                  onChange={(e) => {
                    setKelasFilter(e.target.value);
                    setPage(1);
                  }}
                  className="border border-slate-300 rounded-md px-2.5 py-1.5 text-xs bg-white"
                >
                  <option value="">Semua Kelas</option>
                  {db.kelas.map((k) => (
                    <option key={k.id} value={k.id}>{k.nama}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Cari nama, NIS, atau NISN..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-56 border border-slate-300 rounded-md px-3 py-1.5 text-xs"
                />
                {totalPages > 1 && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40"
                    >
                      &larr;
                    </button>
                    <span className="font-mono text-slate-600">{safePage}/{totalPages}</span>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40"
                    >
                      &rarr;
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 font-medium">Foto</th>
                    <th className="py-2 font-medium">NISN / NIS</th>
                    <th className="py-2 font-medium">Nama Siswa</th>
                    <th className="py-2 font-medium">Kelas</th>
                    <th className="py-2 font-medium">Status</th>
                    <th className="py-2 font-medium">Skor Wajah</th>
                    <th className="py-2 font-medium">Enroll Foto</th>
                    <th className="py-2 font-medium text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pagedStudents.map((s) => {
                    const kelas = db.kelas.find((k) => k.id === s.kelas_id);
                    const totalPhotos =
                      (s.foto_ref ? 1 : 0) +
                      db.attendance_logs.filter((l) => l.student_id === s.id && Boolean(l.snapshot_path)).length +
                      db.face_update_history.filter((h) => h.student_id === s.id && Boolean(h.snapshot_path)).length;
                    return (
                      <tr key={s.id}>
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            {s.foto_ref ? (
                              <button
                                type="button"
                                onClick={() => openStudentGallery(s)}
                                aria-label={`Perbesar foto wajah ${s.nama}`}
                                className="group relative rounded overflow-hidden border border-slate-200 hover:border-blue-500 shrink-0"
                              >
                                <img
                                  src={s.foto_ref}
                                  alt={s.nama}
                                  referrerPolicy="no-referrer"
                                  className="w-12 h-12 object-cover bg-slate-100"
                                />
                                <span className="absolute bottom-0.5 right-0.5 bg-slate-900/75 text-white rounded p-0.5">
                                  <ZoomIn className="w-2.5 h-2.5" />
                                </span>
                              </button>
                            ) : (
                              <div className="w-12 h-12 rounded bg-slate-100 flex items-center justify-center text-xs font-semibold text-slate-500">
                                {s.nama.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                            {totalPhotos > 1 && (
                              <button
                                type="button"
                                onClick={() => openStudentGallery(s)}
                                className="text-[11px] font-medium text-blue-700 hover:underline whitespace-nowrap"
                              >
                                {totalPhotos} foto
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="py-2 font-mono tabular-nums text-slate-600">
                          <div>{s.nisn}</div>
                          <div className="text-[11px] text-slate-400">{s.nis}</div>
                        </td>
                        <td className="py-2">
                          <div className="font-medium text-slate-900">{s.nama}</div>
                          <div className="text-[11px] text-slate-400 font-mono">{s.wa_ortu || '-'}</div>
                        </td>
                        <td className="py-2 text-slate-600">{kelas?.nama ?? '-'}</td>
                        <td className="py-2 font-medium text-slate-700">{s.status}</td>
                        <td className="py-2 font-mono tabular-nums">
                          {s.embedding ? (
                            <span className="text-emerald-700 font-semibold">{s.embedding_quality_score.toFixed(3)}</span>
                          ) : (
                            <span className="text-amber-700">Belum Enroll</span>
                          )}
                        </td>
                        <td className="py-2">
                          <label className="inline-block cursor-pointer px-2.5 py-1 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded">
                            Upload Foto
                            <input
                              type="file"
                              accept="image/*"
                              className="sr-only"
                              onChange={(e) => handleSingleFile(s.id, e.target.files?.[0])}
                            />
                          </label>
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => onDeleteStudent(s.id)}
                            aria-label={`Hapus ${s.nama}`}
                            className="p-1.5 text-slate-400 hover:text-red-600 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <FaceLightboxModal
        isOpen={Boolean(lightboxState)}
        onClose={() => setLightboxState(null)}
        title={lightboxState?.title ?? ''}
        subtitle={lightboxState?.subtitle}
        referenceItem={lightboxState?.referenceItem}
        items={lightboxState?.items ?? []}
        initialIndex={lightboxState?.initialIndex ?? 0}
      />
    </div>
  );
};
