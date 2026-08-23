async function toJpegFile(url, title = 'Mate Topp') {
  const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!response.ok) throw new Error('No se pudo cargar la imagen');
  const sourceBlob = await response.blob();

  let jpegBlob = sourceBlob;
  if (sourceBlob.type !== 'image/jpeg') {
    const bitmap = await createImageBitmap(sourceBlob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    jpegBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo convertir la imagen')), 'image/jpeg', 0.94);
    });
  }

  const safeName = String(title || 'Mate Topp')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'mate-topp';

  return new File([jpegBlob], `${safeName}.jpg`, { type: 'image/jpeg' });
}

function downloadJpeg(file) {
  const objectUrl = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

async function shareImage(url, title = 'Mate Topp®') {
  try {
    const file = await toJpegFile(url, title);

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }

    downloadJpeg(file);
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    alert('No se pudo preparar la imagen JPG. Probá nuevamente.');
  }
}

window.shareImage = shareImage;
