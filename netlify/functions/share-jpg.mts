const IMAGES: Record<string,string> = {
  folclore: 'https://mate-topp-ventas.zumematetopp.chatgpt.site/products/jar-folclore.jpg',
  cumbia: 'https://mate-topp-ventas.zumematetopp.chatgpt.site/products/jar-cumbia.jpg'
};

export default async (req: Request) => {
  try {
    const url = new URL(req.url);
    const key = String(url.searchParams.get('image') || '').toLowerCase();
    const source = IMAGES[key];
    if (!source) return new Response('Imagen no encontrada', { status: 404 });

    const response = await fetch(source, { cache: 'no-store' });
    if (!response.ok) return new Response('No se pudo obtener la imagen', { status: 502 });
    const buffer = await response.arrayBuffer();
    const filename = `mate-topp-${key}.jpg`;
    const download = url.searchParams.get('download') === '1';

    return new Response(buffer, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=3600',
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`
      }
    });
  } catch {
    return new Response('No se pudo preparar la imagen', { status: 500 });
  }
};

export const config = { path: '/share-jpg' };
