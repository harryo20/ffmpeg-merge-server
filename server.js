const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const TMP = '/tmp';

app.get('/', (req, res) => {
  res.json({ status: 'FFmpeg server running', version: '1.0.0' });
});

async function downloadFile(url, dest) {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

app.post('/merge', async (req, res) => {
  const jobId = Date.now().toString();
  const jobDir = path.join(TMP, `job_${jobId}`);

  try {
    const { video_urls, audio_url } = req.body;

    if (!video_urls || !Array.isArray(video_urls) || video_urls.length === 0) {
      return res.status(400).json({ error: 'video_urls array is required' });
    }

    fs.mkdirSync(jobDir, { recursive: true });

    const clipPaths = [];
    for (let i = 0; i < video_urls.length; i++) {
      const clipPath = path.join(jobDir, `clip_${String(i).padStart(4, '0')}.mp4`);
      await downloadFile(video_urls[i], clipPath);
      clipPaths.push(clipPath);
    }

    let audioPath = null;
    if (audio_url) {
      audioPath = path.join(jobDir, 'audio.mp3');
      await downloadFile(audio_url, audioPath);
    }

    const concatFile = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));

    const mergedPath = path.join(jobDir, 'merged.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-y'])
        .output(mergedPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const finalPath = path.join(jobDir, 'final_output.mp4');
    if (audioPath && fs.existsSync(audioPath)) {
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(mergedPath)
          .input(audioPath)
          .outputOptions(['-c:v copy', '-c:a aac', '-map 0:v:0', '-map 1:a:0', '-shortest', '-y'])
          .output(finalPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
    } else {
      fs.copyFileSync(mergedPath, finalPath);
    }

    const finalBuffer = fs.readFileSync(finalPath);
    const base64Video = finalBuffer.toString('base64');
    const fileSizeBytes = fs.statSync(finalPath).size;

    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      job_id: jobId,
      file_size_bytes: fileSizeBytes,
      video_base64: base64Video
    });

  } catch (error) {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg merge server running on port ${PORT}`);
});
