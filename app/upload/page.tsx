'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  UploadCloud,
  File as FileIcon,
  X,
  CheckCircle2,
  Sparkles,
  Info,
  Loader2,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

const fileTypesAccepted = ['PDF', 'PPT', 'DOCX', 'ZIP', 'Images', 'Excel', 'Video'];
const acceptedExtensions = ['.pdf', '.ppt', '.pptx', '.docx', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.xlsx', '.xls', '.mp4', '.webm', '.mov'];
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB

interface DbUniversity {
  id: string;
  name: string;
  short: string;
  status: string;
}

interface DbCourse {
  id: string;
  university_id: string;
  code: string;
  title: string;
  status: string;
}

interface DbCategory {
  id: string;
  name: string;
}

function inferContentType(file: File) {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const types: Record<string, string> = {
    pdf: 'application/pdf', ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  };
  return types[extension] ?? 'application/octet-stream';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [accountBlockReason, setAccountBlockReason] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState('Preparing upload…');
  const [submitted, setSubmitted] = useState(false);
  const [submittedResourceId, setSubmittedResourceId] = useState('');
  const [error, setError] = useState('');

  // DB reference lists
  const [universitiesList, setUniversitiesList] = useState<DbUniversity[]>([]);
  const [coursesList, setCoursesList] = useState<DbCourse[]>([]);
  const [categoriesList, setCategoriesList] = useState<DbCategory[]>([]);
  const [universitySearch, setUniversitySearch] = useState('');
  const [courseSearch, setCourseSearch] = useState('');
  
  // Custom dialogs state
  const [showAddUniDialog, setShowAddUniDialog] = useState(false);
  const [newUniName, setNewUniName] = useState('');
  const [newUniShort, setNewUniShort] = useState('');
  const [addingUni, setAddingUni] = useState(false);

  const [showAddCourseDialog, setShowAddCourseDialog] = useState(false);
  const [newCourseCode, setNewCourseCode] = useState('');
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [addingCourse, setAddingCourse] = useState(false);

  const [form, setForm] = useState({
    title: '',
    universityId: '',
    department: '',
    courseId: '',
    courseCode: '',
    semester: '',
    subject: '',
    category: '',
    description: '',
    tags: '',
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auth gate & load initial DB lists
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/auth');
        return;
      }

      const { data: accountStatus, error: accountStatusError } = await supabase.rpc('get_my_account_status');
      if (accountStatusError) {
        setAccountBlockReason('Your account status could not be verified. Reload the page before uploading.');
        setAuthChecked(true);
        return;
      }
      if (accountStatus === 'deleted') {
        await supabase.auth.signOut({ scope: 'local' });
        router.replace('/auth?error=account_unavailable');
        return;
      }
      if (accountStatus !== 'active') {
        setAccountBlockReason('This account is suspended. Existing private data remains available, but uploads and other changes are disabled.');
        setAuthChecked(true);
        return;
      }
      setAuthChecked(true);

      const { data: categoryData, error: categoryError } = await supabase.from('categories').select('id, name').order('name').limit(250);
      if (categoryError) setError('Upload categories could not be loaded. Retry before submitting.');
      else if (categoryData) setCategoriesList(categoryData);
    })();
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    const timer = window.setTimeout(() => {
      const normalized = universitySearch.trim().replace(/[%_,()]/g, ' ');
      let lookup = supabase.from('universities').select('id, name, short, status');
      if (normalized) lookup = lookup.or(`name.ilike.%${normalized}%,short.ilike.%${normalized}%`);
      void lookup.order('name').limit(50).then(({ data, error: lookupError }) => {
        if (lookupError) setError('Universities could not be loaded. Retry your search.');
        else setUniversitiesList((data ?? []) as DbUniversity[]);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [authChecked, universitySearch]);

  // Load courses whenever selected university changes
  useEffect(() => {
    if (!form.universityId) {
      setCoursesList([]);
      return;
    }
    const timer = window.setTimeout(() => {
      const normalized = courseSearch.trim().replace(/[%_,()]/g, ' ');
      let lookup = supabase
        .from('courses')
        .select('id, university_id, code, title, status')
        .eq('university_id', form.universityId);
      if (normalized) lookup = lookup.or(`code.ilike.%${normalized}%,title.ilike.%${normalized}%`);
      void lookup.order('code').limit(50).then(({ data, error: lookupError }) => {
        if (lookupError) setError('Courses could not be loaded. Retry your search.');
        else setCoursesList((data ?? []) as DbCourse[]);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [courseSearch, form.universityId]);

  const update = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Add custom university
  const handleAddCustomUniversity = async () => {
    if (!newUniName.trim()) return;
    setAddingUni(true);
    try {
      const shortName = newUniShort.trim() || newUniName.slice(0, 5).toUpperCase();
      const { data, error } = await supabase
        .from('universities')
        .insert({
          name: newUniName.trim(),
          short: shortName,
          country: 'Global',
          status: 'custom_pending',
        })
        .select('id, name, short, status')
        .single();

      if (error) throw error;
      if (data) {
        setUniversitiesList((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
        update('universityId', data.id);
        setNewUniName('');
        setNewUniShort('');
        setShowAddUniDialog(false);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to add university.');
    } finally {
      setAddingUni(false);
    }
  };

  // Add custom course
  const handleAddCustomCourse = async () => {
    if (!form.universityId || !newCourseCode.trim() || !newCourseTitle.trim()) return;
    setAddingCourse(true);
    try {
      const { data, error } = await supabase
        .from('courses')
        .insert({
          university_id: form.universityId,
          code: newCourseCode.trim().toUpperCase(),
          title: newCourseTitle.trim(),
          status: 'custom_pending',
        })
        .select('id, university_id, code, title, status')
        .single();

      if (error) throw error;
      if (data) {
        setCoursesList((prev) => [...prev, data]);
        update('courseId', data.id);
        update('courseCode', data.code);
        setNewCourseCode('');
        setNewCourseTitle('');
        setShowAddCourseDialog(false);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to add course.');
    } finally {
      setAddingCourse(false);
    }
  };

  const handleFileSelect = useCallback((selected: File | null) => {
    if (!selected) return;
    setError('');
    const ext = '.' + (selected.name.split('.').pop()?.toLowerCase() ?? '');
    if (!acceptedExtensions.includes(ext)) {
      setError(`Unsupported file type. Accepted: ${fileTypesAccepted.join(', ')}`);
      return;
    }
    if (selected.size > MAX_SIZE) {
      setError('File too large. Maximum size is 100 MB.');
      return;
    }
    setFile(selected);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files[0] ?? null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Please select a file to upload.');
      return;
    }
    setError('');
    setUploading(true);
    setUploadStage('Preparing secure upload…');
    setUploadProgress(10);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/auth');
        return;
      }
      const token = session.access_token;
      const contentType = inferContentType(file);

      // 1. Get Cloudflare R2 Presigned Upload URL
      const presignedRes = await fetch('/api/upload/presigned-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
        }),
      });

      if (!presignedRes.ok) {
        const errJson = await presignedRes.json();
        throw new Error(errJson.error?.message || 'Could not prepare upload session.');
      }

      const { uploadUrl, storageKey, requiredHeaders } = await presignedRes.json();

      setUploadProgress(30);
      setUploadStage('Uploading file to private storage…');

      // 2. Upload file directly to Cloudflare R2 via Presigned PUT URL
      const r2UploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: requiredHeaders || {
          'Content-Type': contentType,
        },
        body: file,
      });

      if (!r2UploadRes.ok) {
        throw new Error('Direct file stream to Cloudflare R2 failed.');
      }

      setUploadProgress(70);
      setUploadStage('Verifying file and finalizing metadata…');

      const userTags = form.tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const finalizeRes = await fetch('/api/upload/finalize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          storageKey,
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
          title: form.title,
          description: form.description,
          universityId: form.universityId,
          courseId: form.courseId,
          categoryId: form.category || null,
          department: form.department,
          courseCode: form.courseCode,
          semester: form.semester,
          subject: form.subject,
          tags: userTags,
        }),
      });
      if (!finalizeRes.ok) {
        const finalizeError = await finalizeRes.json();
        throw new Error(finalizeError.error?.message || 'The uploaded file could not be finalized.');
      }
      const finalized = await finalizeRes.json();

      setUploadProgress(100);
      setUploadStage('Upload finalized and awaiting moderation.');
      setSubmittedResourceId(finalized.resourceId || '');
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const resetForm = () => {
    setSubmitted(false);
    setFile(null);
    setUploadProgress(0);
    setUploadStage('Preparing upload…');
    setSubmittedResourceId('');
    setError('');
    setForm({ title: '', universityId: '', department: '', courseId: '', courseCode: '', semester: '', subject: '', category: '', description: '', tags: '' });
  };

  if (!authChecked) {
    return (
      <div className="flex min-h-[calc(100vh-5rem)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (accountBlockReason) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-2xl items-center px-4 py-12">
        <div className="w-full rounded-2xl border border-border bg-card p-8 shadow-sm">
          <h1 className="font-display text-3xl font-bold tracking-tight">Uploads unavailable</h1>
          <p className="mt-3 text-muted-foreground" role="alert">{accountBlockReason}</p>
          <Button className="mt-6" variant="outline" onClick={() => window.location.reload()}>
            Retry account check
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Upload a Resource</h1>
        <p className="mt-2 text-muted-foreground">
          Share your study materials to Cloudflare R2 and earn XP. Powered by Gemini AI.
        </p>
      </motion.div>

      <AnimatePresence mode="wait">
        {submitted ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="mt-10 flex flex-col items-center justify-center rounded-3xl border border-border bg-card p-12 text-center shadow-soft"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200, delay: 0.2 }}
              className="flex h-20 w-20 items-center justify-center rounded-full bg-success/10 text-success"
            >
              <CheckCircle2 className="h-10 w-10" />
            </motion.div>
            <h2 className="mt-6 font-display text-2xl font-bold">Upload complete!</h2>
            <p className="mt-2 max-w-md text-muted-foreground">
              Your file was verified in Cloudflare R2 and its resource record is awaiting moderation. Supported PDFs are queued for AI processing when Gemini is configured. You earned +50 XP.
            </p>
            <div className="mt-6 flex gap-3">
              <Button className="rounded-xl" onClick={resetForm}>Upload another</Button>
              <Button variant="outline" className="rounded-xl" asChild>
                <a href={submittedResourceId ? `/resource/${submittedResourceId}` : '/dashboard'}>
                  View upload status
                </a>
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onSubmit={handleSubmit}
            className="mt-10 space-y-8"
          >
            {/* file dropzone */}
            <div>
              <label className="mb-2 block text-sm font-semibold">File</label>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed p-10 text-center transition-all',
                  dragOver ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-primary/40',
                )}
              >
                {file ? (
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <FileIcon className="h-6 w-6" />
                    </div>
                    <div className="text-left">
                      <div className="text-sm font-semibold">{file.name}</div>
                      <div className="text-xs text-muted-foreground">{formatFileSize(file.size)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                      className="ml-2 rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <motion.div
                      animate={{ y: [0, -8, 0] }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                      className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/10 to-secondary/10 text-primary"
                    >
                      <UploadCloud className="h-8 w-8" />
                    </motion.div>
                    <p className="mt-4 text-sm font-medium">Drag & drop your file here</p>
                    <p className="mt-1 text-xs text-muted-foreground">or click to browse</p>
                    <p className="mt-3 text-xs text-muted-foreground">Max 100 MB • {fileTypesAccepted.join(', ')}</p>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={acceptedExtensions.join(',')}
                  className="hidden"
                  onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
                />
              </div>
            </div>

            {/* form fields */}
            <div className="grid gap-5 rounded-3xl border border-border bg-card p-6 shadow-soft md:grid-cols-2">
              <Field label="Title" required full>
                <input
                  required
                  value={form.title}
                  onChange={(e) => update('title', e.target.value)}
                  placeholder="e.g. Corporate Finance — Complete Lecture Notes"
                  className="form-input"
                />
              </Field>

              {/* University Select & Add Custom */}
              <Field label="University" required>
                <input
                  type="search"
                  value={universitySearch}
                  onChange={(event) => {
                    setUniversitySearch(event.target.value);
                    update('universityId', '');
                    update('courseId', '');
                    update('courseCode', '');
                    setCourseSearch('');
                  }}
                  aria-label="Search universities"
                  placeholder="Search university name or abbreviation"
                  className="form-input mb-2"
                />
                <div className="flex gap-2">
                  <select
                    required
                    value={form.universityId}
                    onChange={(e) => {
                      update('universityId', e.target.value);
                      update('courseId', '');
                      update('courseCode', '');
                      setCourseSearch('');
                    }}
                    className="filter-select flex-1"
                  >
                    <option value="">Select university</option>
                    {universitiesList.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} {u.status === 'custom_pending' ? '(Pending Review)' : ''}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title="Add custom university if not found"
                    onClick={() => setShowAddUniDialog(true)}
                    className="rounded-xl border-border"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </Field>

              {/* Course Select & Add Custom */}
              <Field label="Course & Short Code" required>
                <input
                  type="search"
                  value={courseSearch}
                  onChange={(event) => {
                    setCourseSearch(event.target.value);
                    update('courseId', '');
                    update('courseCode', '');
                  }}
                  disabled={!form.universityId}
                  aria-label="Search courses"
                  placeholder={form.universityId ? 'Search course code or title' : 'Select a university first'}
                  className="form-input mb-2 disabled:opacity-50"
                />
                <div className="flex gap-2">
                  <select
                    required
                    value={form.courseId}
                    disabled={!form.universityId}
                    onChange={(e) => {
                      const selectedCrs = coursesList.find((c) => c.id === e.target.value);
                      update('courseId', e.target.value);
                      if (selectedCrs) update('courseCode', selectedCrs.code);
                    }}
                    className="filter-select flex-1 disabled:opacity-50"
                  >
                    <option value="">
                      {form.universityId ? 'Select course / short code' : 'Select university first'}
                    </option>
                    {coursesList.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} — {c.title}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={!form.universityId}
                    title="Add custom course code if not found"
                    onClick={() => setShowAddCourseDialog(true)}
                    className="rounded-xl border-border disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </Field>

              <Field label="Department" required>
                <input
                  required
                  value={form.department}
                  onChange={(e) => update('department', e.target.value)}
                  placeholder="e.g. Finance & Accounting"
                  className="form-input"
                />
              </Field>

              <Field label="Semester" required>
                <input
                  required
                  minLength={2}
                  value={form.semester}
                  onChange={(e) => update('semester', e.target.value)}
                  placeholder="e.g. Fall 2024"
                  className="form-input"
                />
              </Field>

              {/* Required by finalizeUploadSchema and indexed for search. The
                  form submitted form.subject while rendering no input for it,
                  so every upload failed validation with an empty subject. */}
              <Field label="Subject" required>
                <input
                  required
                  minLength={2}
                  value={form.subject}
                  onChange={(e) => update('subject', e.target.value)}
                  placeholder="e.g. Corporate Finance"
                  className="form-input"
                />
              </Field>

              <Field label="Category" full>
                <select value={form.category} onChange={(e) => update('category', e.target.value)} className="filter-select">
                  <option value="">Select category</option>
                  {categoriesList.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>

              <Field label="Description" required full>
                <textarea
                  required
                  minLength={10}
                  value={form.description}
                  onChange={(e) => update('description', e.target.value)}
                  placeholder="Describe what this resource contains..."
                  className="form-input h-28 resize-none"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {form.description.trim().length < 10
                    ? `At least 10 characters (${form.description.trim().length}/10).`
                    : `${form.description.trim().length} characters.`}
                </p>
              </Field>

              <Field label="Tags" full>
                <input
                  value={form.tags}
                  onChange={(e) => update('tags', e.target.value)}
                  placeholder="comma-separated, e.g. corporate-finance, fin-435, valuation"
                  className="form-input"
                />
              </Field>
            </div>

            {/* AI features hint */}
            <div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-semibold text-primary">Optional Gemini AI enrichment</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  The upload succeeds independently of AI. Supported PDFs are queued after storage verification when a Gemini model is configured.
                </p>
              </div>
            </div>

            {error && (
              <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
            )}

            {uploading && (
              <div className="rounded-2xl border border-border bg-card p-4 shadow-soft">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    {uploadStage}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{uploadProgress}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-primary to-secondary"
                    initial={{ width: '0%' }}
                    animate={{ width: `${uploadProgress}%` }}
                    transition={{ ease: 'easeOut' }}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-4 w-4" />
                By uploading, you confirm you have the right to share this content.
              </p>
              <Button
                type="submit"
                size="lg"
                disabled={uploading}
                className="h-12 rounded-2xl bg-gradient-to-r from-primary to-secondary px-8 shadow-glow disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <UploadCloud className="mr-2 h-5 w-5" />
                )}
                {uploading ? 'Uploading...' : 'Upload Resource'}
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Add Custom University Modal */}
      {showAddUniDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-glow">
            <h3 className="text-xl font-bold">Add Custom University</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              If your university is not in the list, type it below. Admins will review and merge custom entries.
            </p>
            <div className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-semibold">University Full Name</label>
                <input
                  value={newUniName}
                  onChange={(e) => setNewUniName(e.target.value)}
                  placeholder="e.g. Boston University"
                  className="form-input mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-semibold">Abbreviation / Short Code</label>
                <input
                  value={newUniShort}
                  onChange={(e) => setNewUniShort(e.target.value)}
                  placeholder="e.g. BU"
                  className="form-input mt-1"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setShowAddUniDialog(false)}>Cancel</Button>
              <Button onClick={handleAddCustomUniversity} disabled={addingUni || !newUniName.trim()}>
                {addingUni ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save University'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Custom Course Modal */}
      {showAddCourseDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-glow">
            <h3 className="text-xl font-bold">Add Custom Course</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a new course short code and title for this university.
            </p>
            <div className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-semibold">Course Code (e.g., ACC-401, FIN-435)</label>
                <input
                  value={newCourseCode}
                  onChange={(e) => setNewCourseCode(e.target.value)}
                  placeholder="e.g. FIN-435"
                  className="form-input mt-1 uppercase"
                />
              </div>
              <div>
                <label className="text-xs font-semibold">Course Title</label>
                <input
                  value={newCourseTitle}
                  onChange={(e) => setNewCourseTitle(e.target.value)}
                  placeholder="e.g. Advanced Financial Modeling"
                  className="form-input mt-1"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setShowAddCourseDialog(false)}>Cancel</Button>
              <Button onClick={handleAddCustomCourse} disabled={addingCourse || !newCourseCode.trim() || !newCourseTitle.trim()}>
                {addingCourse ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Course'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children, required, full }: { label: string; children: React.ReactNode; required?: boolean; full?: boolean }) {
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      <label className="mb-1.5 block text-sm font-semibold">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}
