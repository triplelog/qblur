# Default photos

Put a photo or two here and list them in `index.json`; the editor then opens
on the first one (the test picture stays available in the picture chooser),
and `npm run build` copies the folder to `site/photos/`.

```json
[
  { "file": "harbour.jpg", "title": "Harbour", "credit": "Photo by [Jane Doe](https://unsplash.com/@janedoe) on [Unsplash](https://unsplash.com/photos/…)" },
  { "file": "portrait.jpg", "title": "Portrait", "credit": "Photo by John Roe (Pexels)" }
]
```

- JPEG, about 1200–1600 px on the long side and under 400 KB each: the
  preview is at most 480 × 360, and *Download PNG* draws the filter at the
  photo's own size, so bigger only costs download time.
- One with a face or clear shapes (for edges, blur, spotlight) and one
  with strong colours (chroma key, tint, posterize) show the library well.
- Use pictures you have the rights to publish (CC0 / the Unsplash or
  Pexels licences) and keep the credit line; it is shown under the picture.
  `[text](https://…)` in it becomes a link (Unsplash asks for two: the
  photographer and the photo); anything else is plain text.
- Videos (.mp4, H.264) go in the same list and play muted and looped, `t`
  counting their frames. Keep them short and small — 8 s at 960 px is
  1–3 MB: `ffmpeg -t 8 -i in.mp4 -vf "scale=960:-2,fps=30" -an -c:v libx264 -crf 27 -pix_fmt yuv420p -movflags +faststart out.mp4`.
- `"person": "portrait.person.png"` on a photo is its person's outline, worked out ahead (white = the person, the size of
  the model's copy: 1024 on the long side). The profile-picture page uses it for that sample, so opening the page
  doesn't download the 19 MB model. After changing the photo, `node tools/person-outline.mjs portrait.jpg` makes it again.
- Raw downloads can live in `originals/` here: it is git-ignored and not copied to the site.
- To shrink a photo on a Mac: `sips -Z 1600 -s format jpeg -s formatOptions 82 photo.jpg --out photo.jpg`.
- `?picture=test` on the editor's URL (or the chooser) brings the test
  picture back; the checkers use it so their numbers stay comparable.
