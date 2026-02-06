/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

const MODE = process.env.TRANSCODER_MODE || 'dry-run'; // "dry-run" | "active"
const POLL_INTERVAL_MS = Number(process.env.TRANSCODER_POLL_MS || 10000);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function getSupabase() {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}

function getR2Client() {
  // Support Railway S3 or any S3-compatible storage
  return new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: requireEnv('S3_ENDPOINT'),
    credentials: {
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY')
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' // Railway and some S3-compatible services need this
  });
}

async function getR2SignedUrl(client, key, method, expiresInSeconds) {
  const bucket = requireEnv('S3_BUCKET');
  if (method === 'PUT') {
    return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSeconds
    });
  }
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: expiresInSeconds
  });
}

async function downloadToFile(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url} (${res.status})`);
  if (!res.body) throw new Error('Download response has no body');

  const out = fs.createWriteStream(outputPath);
  const stream = res.body.pipe ? res.body : Readable.fromWeb(res.body);

  await new Promise((resolve, reject) => {
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    stream.pipe(out);
  });
}

async function uploadFileToR2(client, key, filePath, contentType) {
  const bucket = requireEnv('S3_BUCKET');
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType
    })
  );
}

async function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const duration =
        metadata.format && metadata.format.duration
          ? Math.floor(Number(metadata.format.duration))
          : null;
      resolve(duration);
    });
  });
}

async function generatePoster(inputPath, posterPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        timestamps: [1],
        filename: path.basename(posterPath),
        folder: path.dirname(posterPath),
        size: '1280x720'
      })
      .on('end', resolve)
      .on('error', reject);
  });
}

async function generateHls(inputPath, hlsPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .addOption('-profile:v', 'baseline')
      .addOption('-level', '3.0')
      .outputOptions('-start_number 0', '-hls_time 10', '-hls_list_size 0', '-f hls')
      .output(hlsPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function pick(job, camel, snake) {
  if (job[camel] != null) return job[camel];
  if (snake && job[snake] != null) return job[snake];
  return undefined;
}

function computeNextAttempt(attempts) {
  const backoffSeconds = Math.pow(2, attempts) * 60;
  return new Date(Date.now() + backoffSeconds * 1000).toISOString();
}

async function listJobs(supabase) {
  const nowIso = new Date().toISOString();
  const pending = await supabase
    .from('transcode_jobs')
    .select('*')
    .eq('status', 'pending')
    .limit(5);

  const retryable = await supabase
    .from('transcode_jobs')
    .select('*')
    .eq('status', 'failed')
    .lte('next_attempt_at', nowIso)
    .limit(5);

  if (pending.error) throw pending.error;
  if (retryable.error) throw retryable.error;

  return [...(pending.data || []), ...(retryable.data || [])];
}

async function markJob(supabase, jobId, patch) {
  const { error } = await supabase
    .from('transcode_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) throw error;
}

async function transcodeJob(job, r2Client) {
  void ffmpegPath;
  void ffmpeg;

  const jobId = job.id || job.job_id || job.jobId;
  const fileUrl = pick(job, 'fileUrl', 'file_url');
  const userId = pick(job, 'userId', 'user_id');

  if (!jobId || !fileUrl || !userId) {
    throw new Error('Missing job fields (id, fileUrl, userId)');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecircle-transcode-'));
  const ext = path.extname(new URL(fileUrl).pathname) || '.mp4';
  const inputPath = path.join(tmpDir, `input${ext}`);
  const posterPath = path.join(tmpDir, 'poster.jpg');
  const hlsDir = path.join(tmpDir, 'hls');
  fs.mkdirSync(hlsDir);
  const hlsPath = path.join(hlsDir, 'index.m3u8');

  try {
    await downloadToFile(fileUrl, inputPath);

    const duration = await probeDuration(inputPath);
    await generatePoster(inputPath, posterPath);
    await generateHls(inputPath, hlsPath);

    const destPrefix = `videos/${userId}/${jobId}/hls`;
    const files = fs.readdirSync(hlsDir);

    for (const file of files) {
      const contentType = file.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/MP2T';
      await uploadFileToR2(
        r2Client,
        `${destPrefix}/${file}`,
        path.join(hlsDir, file),
        contentType
      );
    }

    await uploadFileToR2(
      r2Client,
      `${destPrefix}/poster.jpg`,
      posterPath,
      'image/jpeg'
    );

    const hlsUrl = await getR2SignedUrl(
      r2Client,
      `${destPrefix}/index.m3u8`,
      'GET',
      60 * 60 * 24 * 30
    );
    const posterUrl = await getR2SignedUrl(
      r2Client,
      `${destPrefix}/poster.jpg`,
      'GET',
      60 * 60 * 24 * 30
    );

    return { hls: hlsUrl, poster: posterUrl, duration };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function handleJob(supabase, r2Client, job) {
  const jobId = job.id || job.job_id || job.jobId;
  const fileUrl = pick(job, 'fileUrl', 'file_url');
  const userId = pick(job, 'userId', 'user_id');

  if (!jobId || !fileUrl || !userId) {
    console.error('Skipping job with missing fields', { jobId, fileUrl, userId });
    return;
  }

  await markJob(supabase, jobId, { status: 'processing' });

  try {
    let result;
    if (process.env.TRANSCODER_FAKE_SUCCESS === '1') {
      const destPrefix = `videos/${userId}/${jobId}/hls`;
      result = {
        hls: await getR2SignedUrl(r2Client, `${destPrefix}/index.m3u8`, 'GET', 60 * 60),
        poster: await getR2SignedUrl(r2Client, `${destPrefix}/poster.jpg`, 'GET', 60 * 60),
        duration: null,
        note: 'fake-success'
      };
    } else {
      result = await transcodeJob(job, r2Client);
    }

    await markJob(supabase, jobId, {
      status: 'done',
      result
    });
  } catch (err) {
    const attempts = Number(pick(job, 'attemptCount', 'attempt_count') || 0) + 1;
    const maxAttempts = Number(pick(job, 'maxAttempts', 'max_attempts') || 5);

    if (attempts < maxAttempts) {
      await markJob(supabase, jobId, {
        status: 'failed',
        attempt_count: attempts,
        next_attempt_at: computeNextAttempt(attempts),
        result: { error: String(err) }
      });
      console.warn(`Job ${jobId} scheduled to retry (attempt ${attempts}/${maxAttempts})`);
    } else {
      await markJob(supabase, jobId, {
        status: 'failed',
        attempt_count: attempts,
        result: { error: String(err) }
      });
      console.warn(`Job ${jobId} permanently failed after ${attempts} attempts`);
    }
  }
}

async function main() {
  console.log(`[transcoder] mode=${MODE}, poll=${POLL_INTERVAL_MS}ms`);

  const supabase = getSupabase();
  const r2Client = MODE === 'active' ? getR2Client() : null;

  while (true) {
    try {
      const jobs = await listJobs(supabase);

      if (MODE === 'dry-run') {
        if (jobs.length) {
          console.log(`[transcoder] dry-run found ${jobs.length} job(s)`);
          jobs.forEach((j) => console.log(' -', j.id || j.job_id || j.jobId));
        }
      } else {
        for (const job of jobs) {
          await handleJob(supabase, r2Client, job);
        }
      }
    } catch (err) {
      console.error('[transcoder] error', err);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('[transcoder] fatal', err);
  process.exit(1);
});
