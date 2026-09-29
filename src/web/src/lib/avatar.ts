/** The side a profile photo is scaled down to before it is sent — what the iOS and macOS apps send. */
export const AVATAR_SIDE = 512;

/**
 * A chosen image as a profile photo is sent: its middle square, scaled down to at most
 * `AVATAR_SIDE` pixels, as a JPEG on white. The server keeps what it is given, so the size is
 * decided here.
 */
export async function squareJpeg(image: Blob, side = AVATAR_SIDE): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  const edge = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(edge, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const context = canvas.getContext('2d');
  if (!context) throw new Error("this browser can't draw the photo");
  context.fillStyle = '#fff';
  context.fillRect(0, 0, out, out);
  context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, out, out);
  bitmap.close();
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("the photo couldn't be encoded"))),
      'image/jpeg',
      0.85,
    ),
  );
}
