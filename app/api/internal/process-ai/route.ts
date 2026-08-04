import { type NextRequest, NextResponse } from 'next/server';
import pdf from 'pdf-parse';
import { getR2ObjectBytes } from '@/lib/cloudflare-r2';
import { isGeminiConfigured, summarizeDocumentText } from '@/lib/gemini';
import { createServiceRoleSupabaseClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ClaimedJob = {
  job_id: string;
  resource_id: string;
  storage_key: string;
  resource_title: string;
};

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get('authorization') === `Bearer ${secret}`);
}

function aiSourceLimit() {
  const configured = Number(process.env.AI_MAX_SOURCE_BYTES || 15 * 1024 * 1024);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 25 * 1024 * 1024)
    : 15 * 1024 * 1024;
}

function failureCode(error: unknown) {
  if (error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)) return error.message;
  if (error instanceof SyntaxError) return 'AI_RESPONSE_INVALID';
  return 'AI_PROCESSING_FAILED';
}

async function processNextJob(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!isGeminiConfigured()) return NextResponse.json({ error: 'AI is not configured.' }, { status: 503 });

  const supabase = createServiceRoleSupabaseClient();
  const expiry = new Date().toISOString();
  await Promise.all([
    supabase.from('api_rate_limit_buckets').delete().lt('expires_at', expiry),
    supabase.from('api_ip_rate_limit_buckets').delete().lt('expires_at', expiry),
  ]);
  const workerId = crypto.randomUUID();
  const { data, error } = await supabase.rpc('claim_ai_processing_job', { p_worker_id: workerId });
  if (error) {
    console.error('ai.worker.claim_failed', { code: error.code });
    return NextResponse.json({ error: 'Could not claim an AI job.' }, { status: 500 });
  }

  const job = (Array.isArray(data) ? data[0] : data) as ClaimedJob | null;
  if (!job) return NextResponse.json({ processed: false, reason: 'queue_empty' });

  try {
    const file = await getR2ObjectBytes(job.storage_key, aiSourceLimit());
    // @types/pdf-parse declares Buffer, but a Buffer is exactly what breaks
    // pdf.js's internal clone step. getR2ObjectBytes returns a Uint8Array
    // deliberately; see the note on that function.
    const document = await pdf(file as unknown as Buffer, { max: 200 });
    const documentText = document.text.trim();
    if (!documentText) throw new Error('PDF_TEXT_EMPTY');

    const result = await summarizeDocumentText(documentText, job.resource_title);
    const { error: completionError } = await supabase.rpc('complete_ai_processing_job', {
      p_job_id: job.job_id,
      p_worker_id: workerId,
      p_summary: result.summary,
      p_topics: result.keyTopics,
      p_tags: result.suggestedTags,
      p_reading_time_minutes: result.readingTimeMinutes,
    });
    if (completionError) throw new Error('AI_COMPLETION_WRITE_FAILED');

    return NextResponse.json({ processed: true, resourceId: job.resource_id });
  } catch (error) {
    const code = failureCode(error);
    const { error: failureError } = await supabase.rpc('fail_ai_processing_job', {
      p_job_id: job.job_id,
      p_worker_id: workerId,
      p_error_code: code,
    });
    if (failureError) console.error('ai.worker.failure_write_failed', { code: failureError.code });
    console.error('ai.worker.processing_failed', { resourceId: job.resource_id, code });
    return NextResponse.json({ processed: false, resourceId: job.resource_id, error: code }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return processNextJob(request);
}

export async function POST(request: NextRequest) {
  return processNextJob(request);
}
