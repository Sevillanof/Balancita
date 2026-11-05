# Medir si las noticias anticipan el precio

Informe de solo lectura: por cada noticia que Qwen analizó (relevancia y dirección, preguntas v2) mide cuánto se movió ETH a **1 h, 4 h y 12 h** desde que Balancita la conoció. No cambia el trader ni las bases.

```
PYTHONPATH=python python3 -m balancita_engine.futures_news_effect \
  --news-db <futures-news.sqlite> --market-db <futures-market.sqlite> \
  [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--json]
```

`--desde` incluye ese día y `--hasta` no (UTC). Sirve igual sobre una copia del VPS (`~/balancita-vps-respaldo/ultima-copia`).

## Cómo leerlo

- **acierto %**: noticias alcistas tras las que ETH subió, o bajistas tras las que bajó. 50 % es azar.
- **pb medio a favor**: movimiento medio en puntos básicos en la dirección que dijo la noticia; negativo = el precio fue en contra.
- **Neutrales**: no tienen dirección; se cuentan aparte.
- **Latencia de ingesta**: minutos entre la publicación y la llegada. Las fuentes que cargaron su historial al empezar muestran latencias enormes; mirar la mediana de las fuentes de flujo continuo.
- **Descartadas sin análisis**: noticias que no llegaron a Qwen (ventana de 30 min o filtro de titulares de precio), ordenadas por cuánto se movió ETH en la hora siguiente. Si arriba aparecen noticias que movieron el mercado, el filtro está tirando información útil.
- Sin vela de 5 m cerrada en la hora previa no hay precio: ese horizonte queda vacío, nunca se inventa.

Las muestras son chicas y las noticias se agrupan en los mismos eventos: un acierto de 55 % con n=50 no es una ventaja demostrada.
