/** @type {import('tailwindcss').Config} */
export default {
  // ------------------------------------------------------------------
  // QUE LEE TAILWIND
  //
  // Sin esto, Tailwind no genera nada: mira los ficheros que indiques aqui y solo limpia
  // las clases que encuentra en ellos. Si se olvida una ruta, el estilo aparece en unas
  // paginas y en otras no, que es la forma mas desconcertante de que esto falle.
  // ------------------------------------------------------------------
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // Paleta propia, para no tener los colores escritos a mano en cada componente.
      // Los nombres son del tema, no del color: si mañana se cambia el verde, se cambia
      // aqui y en ningun otro sitio.
      colors: {
        mesa: {
          900: '#0f0f1a',
          800: '#16213e',
          700: '#1e2a4a',
          borde: '#2a2a4a',
        },
        verde: {
          claro: '#00d26a',
          fuerte: '#00b894',
        },
        oro: {
          claro: '#ffd700',
          fuerte: '#f5a623',
        },
      },
    },
  },
  plugins: [],
};