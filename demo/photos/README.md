# Default photos

`home.jpg` is the home page's one picture (800 px, ~50 KB: `sips -Z 800 -s format jpeg -s formatOptions 62 mountains.jpg --out home.jpg`;
its credit is written in demo/index.html) and is not in the list.

Put a photo or two here and list them in `index.json`; the editor then opens
on the first one (the test picture stays available in the picture chooser),
and `npm run build` copies the folder to `site/photos/`.

```json
[
  { "file": "harbor.jpg", "title": "Harbor", "credit": "Photo by [Jane Doe](https://unsplash.com/@janedoe) on [Unsplash](https://unsplash.com/photos/…)" },
  { "file": "portrait.jpg", "title": "Portrait", "credit": "Photo by John Roe (Pexels)" }
]
```

- JPEG, about 1200–1600 px on the long side and under 400 KB each: the
  preview is at most 1440 × 1080 ("sharpest"), and *Download PNG* draws the filter at the
  photo's own size, so bigger only costs download time.
- One with a face or clear shapes (for edges, blur, spotlight) and one
  with strong colors (chroma key, tint, posterize) show the library well.
- Use pictures you have the rights to publish (CC0 / the Unsplash or
  Pexels licenses) and keep the credit line; it is shown under the picture.
  `[text](https://…)` in it becomes a link (Unsplash asks for two: the
  photographer and the photo); anything else is plain text.
- Videos (.mp4, H.264) go in the same list and play muted and looped, `t`
  counting their frames. Keep them short and small — 8 s at 960 px is
  1–3 MB: `ffmpeg -t 8 -i in.mp4 -vf "scale=960:-2,fps=30" -an -c:v libx264 -crf 27 -pix_fmt yuv420p -movflags +faststart out.mp4`.
- `"person": "anson_profile.person.png"` on a photo is its person's outline, worked out ahead (white = the person, the size of
  the model's copy: 1024 on the long side). The profile-picture page uses it for that sample, so opening the page
  doesn't download the 19 MB model. After changing the photo, `node tools/person-outline.mjs anson_profile.jpg` makes it again.
- `"profile": true` makes a photo one of the profile-picture page's examples (only those are offered there; the tool above needs it).
  When the usual guess (two points down the middle) misses part of the person, outline it from more points and list them as
  `"personPoints": [[x, y], …]` (0–1 of the photo): the page starts the user's marks from them (anson_profile.jpg: head, collar, jersey;
  cropped from the Library of Congress's master TIFF, `originals/anson-loc-bbc.0555fu.tif`, with
  `magick 0555fu.tif -crop 1595x1488+95+400 +repage -resize 1200x1200 -strip -interlace JPEG -quality 78`, its outline cleaned
  with `-morphology Close Disk:8 -morphology Open Disk:2` against the card's halftone dots).
- Raw downloads can live in `originals/` here: it is git-ignored and not copied to the site.
- To shrink a photo on a Mac: `sips -Z 1600 -s format jpeg -s formatOptions 82 photo.jpg --out photo.jpg`.
- `?picture=test` on the editor's URL (or the chooser) brings the test
  picture back; the checkers use it so their numbers stay comparable.
