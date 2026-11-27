use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
pub struct VideoFrame {
    pub frame_index: usize,
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

pub fn probe_video_dimensions(video_path: &Path) -> Result<(u32, u32), String> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
        ])
        .arg(video_path)
        .output()
        .map_err(|e| format!("failed to run ffprobe: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "ffprobe exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let first_line = text.lines().next().unwrap_or("").trim();
    let mut parts = first_line.split('x');
    let w: u32 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("invalid ffprobe width in '{first_line}'"))?;
    let h: u32 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("invalid ffprobe height in '{first_line}'"))?;
    Ok((w, h))
}

/// Decodes up to `max_frames` RGB24 frames from `video_path` using ffmpeg so Path A, Path B,
/// and the Python comparison script see bit-for-bit identical decoded frames.
pub fn decode_video_frames_ffmpeg(
    video_path: &Path,
    max_frames: usize,
    sample_fps: Option<f32>,
) -> Result<Vec<VideoFrame>, String> {
    let (width, height) = probe_video_dimensions(video_path)?;
    let frame_bytes = (width as usize) * (height as usize) * 3;

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-v", "error", "-i"]).arg(video_path);
    if let Some(fps) = sample_fps {
        if fps > 0.0 {
            cmd.args(["-vf", &format!("fps={fps:.3}")]);
        }
    }
    cmd.args([
        "-frames:v",
        &max_frames.to_string(),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout unavailable".to_string())?;

    let mut frames = Vec::new();
    let mut idx = 0usize;
    loop {
        let mut buf = vec![0u8; frame_bytes];
        let mut read_total = 0usize;
        while read_total < frame_bytes {
            let n = stdout
                .read(&mut buf[read_total..])
                .map_err(|e| format!("read ffmpeg rawvideo failed: {e}"))?;
            if n == 0 {
                break;
            }
            read_total += n;
        }
        if read_total == 0 {
            break;
        }
        if read_total != frame_bytes {
            return Err(format!(
                "truncated frame {idx}: got {read_total} bytes, expected {frame_bytes}"
            ));
        }
        frames.push(VideoFrame {
            frame_index: idx,
            width,
            height,
            rgb: buf,
        });
        idx += 1;
        if idx >= max_frames {
            break;
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("wait ffmpeg failed: {e}"))?;
    if !status.success() && frames.is_empty() {
        return Err(format!("ffmpeg failed with {status}"));
    }

    Ok(frames)
}
