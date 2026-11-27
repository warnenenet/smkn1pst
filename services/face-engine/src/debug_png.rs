use crate::pipeline::DebugAnnotation;
use image::{ImageFormat, Rgb, RgbImage};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

/// Writes annotated debug PNGs strictly into `/tmp` (`debug_tmp_dir`), throttled per camera
/// (`>= interval_sec`) and capped to a bounded file count (`max_files`).
pub struct DebugPngWriter {
    dir: PathBuf,
    interval_ms: u64,
    max_files: usize,
    last_written_ms_by_cam: HashMap<i64, u64>,
}

impl DebugPngWriter {
    pub fn new(dir: PathBuf, interval_sec: u64, max_files: usize) -> Self {
        Self {
            dir,
            interval_ms: interval_sec.max(5) * 1000,
            max_files: max_files.max(1),
            last_written_ms_by_cam: HashMap::new(),
        }
    }

    pub fn maybe_write_sync(
        &mut self,
        camera_id: i64,
        rgb: &[u8],
        width: u32,
        height: u32,
        annotations: &[DebugAnnotation],
        now_ms: u64,
    ) -> Option<PathBuf> {
        if annotations.is_empty() || width == 0 || height == 0 {
            return None;
        }
        if rgb.len() != (width as usize) * (height as usize) * 3 {
            return None;
        }
        if let Some(&prev) = self.last_written_ms_by_cam.get(&camera_id) {
            if now_ms.saturating_sub(prev) < self.interval_ms {
                return None;
            }
        }
        self.last_written_ms_by_cam.insert(camera_id, now_ms);

        let mut img = RgbImage::from_raw(width, height, rgb.to_vec())?;
        for item in annotations {
            let color = if item.passed {
                Rgb([34, 197, 94])
            } else {
                Rgb([239, 68, 68])
            };
            draw_rect(&mut img, item.bbox, color, 2);
            for pt in item.kps {
                draw_cross(&mut img, pt[0], pt[1], Rgb([59, 130, 246]), 3);
            }
        }

        if std::fs::create_dir_all(&self.dir).is_err() {
            return None;
        }
        let mut png_bytes = Vec::new();
        if img
            .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
            .is_err()
        {
            return None;
        }

        let filename = format!("cam{camera_id}_{now_ms}.png");
        let out_path = self.dir.join(filename);
        if std::fs::write(&out_path, &png_bytes).is_err() {
            return None;
        }
        self.prune_excess_files();
        Some(out_path)
    }

    fn prune_excess_files(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut pngs: Vec<(String, PathBuf)> = entries
            .filter_map(Result::ok)
            .filter_map(|e| {
                let p = e.path();
                if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("png") {
                    let name = p.file_name()?.to_string_lossy().into_owned();
                    Some((name, p))
                } else {
                    None
                }
            })
            .collect();

        if pngs.len() <= self.max_files {
            return;
        }
        pngs.sort_by(|a, b| a.0.cmp(&b.0));
        let excess = pngs.len() - self.max_files;
        for (_, path) in pngs.into_iter().take(excess) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn draw_rect(img: &mut RgbImage, bbox: [f32; 4], color: Rgb<u8>, thickness: i32) {
    let w = img.width() as i32;
    let h = img.height() as i32;
    let x1 = (bbox[0].round() as i32).clamp(0, w - 1);
    let y1 = (bbox[1].round() as i32).clamp(0, h - 1);
    let x2 = (bbox[2].round() as i32).clamp(0, w - 1);
    let y2 = (bbox[3].round() as i32).clamp(0, h - 1);
    if x2 <= x1 || y2 <= y1 {
        return;
    }
    for t in 0..thickness {
        let ty1 = (y1 + t).clamp(0, h - 1) as u32;
        let ty2 = (y2 - t).clamp(0, h - 1) as u32;
        for x in x1..=x2 {
            img.put_pixel(x as u32, ty1, color);
            img.put_pixel(x as u32, ty2, color);
        }
        let tx1 = (x1 + t).clamp(0, w - 1) as u32;
        let tx2 = (x2 - t).clamp(0, w - 1) as u32;
        for y in y1..=y2 {
            img.put_pixel(tx1, y as u32, color);
            img.put_pixel(tx2, y as u32, color);
        }
    }
}

fn draw_cross(img: &mut RgbImage, cx: f32, cy: f32, color: Rgb<u8>, radius: i32) {
    if !cx.is_finite() || !cy.is_finite() {
        return;
    }
    let w = img.width() as i32;
    let h = img.height() as i32;
    let x0 = cx.round() as i32;
    let y0 = cy.round() as i32;
    for d in -radius..=radius {
        let px = x0 + d;
        if px >= 0 && px < w && y0 >= 0 && y0 < h {
            img.put_pixel(px as u32, y0 as u32, color);
        }
        let py = y0 + d;
        if x0 >= 0 && x0 < w && py >= 0 && py < h {
            img.put_pixel(x0 as u32, py as u32, color);
        }
    }
}
