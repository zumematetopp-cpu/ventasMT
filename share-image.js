async function shareImage(url, title = 'Mate Topp®') {
  const text = 'Compartir Mate Topp® en Instagram';
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (response.ok) {
      const blob = await response.blob();
      const type = blob.type || 'image/jpeg';
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      const file = new File([blob], `mate-topp.${ext}`, { type });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ title, text, files: [file] });
        return;
      }
    }
  } catch (error) {
    if (error && error.name === 'AbortError') return;
  }

  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }
  }

  try { await navigator.clipboard.writeText(url); } catch {}
  window.open(url, '_blank', 'noopener');
}

window.shareImage = shareImage;
