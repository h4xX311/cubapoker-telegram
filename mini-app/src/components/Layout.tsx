import type { ReactNode } from 'react';

/** Cabecera consistente para todas las pantallas internas. */
export function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-3 mb-5 pt-1">
      <button
        onClick={onBack}
        className="w-9 h-9 rounded-xl bg-[#16213e] flex items-center justify-center text-white hover:bg-[#1f2b4d] transition-colors"
        aria-label="Volver"
      >
        ←
      </button>
      <h1 className="text-xl font-bold text-white truncate">{title}</h1>
    </div>
  );
}

/** Etiqueta de seccion en mayusculas. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-2.5">{children}</h2>
  );
}

/** Ancho maximo para mantener la linea de lectura en movil. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="p-4 pb-10 animate-fadeIn">{children}</div>;
}
