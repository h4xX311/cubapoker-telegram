import type { Page } from '../lib/types';
import { PageHeader, SectionLabel } from '../components/Layout';

interface Props {
  onBack: () => void;
  onNavigate: (page: Page) => void;
}

/**
 * TORNEOS
 * =======
 *
 * ------------------------------------------------------------------
 * POR QUE ESTA PANTALLA YA NO PIDE DATOS
 *
 * Antes llamaba a `GET /game/tournaments`, una ruta que no existe. El `fetch` devolvia el
 * HTML del 404, el `catch` lo convertia en una lista vacia y la pagina quedaba en "No hay
 * torneos abiertos" para siempre. No era un fallo visible: parecia que no habia torneos.
 *
 * Mientras no exista el producto de torneos con buy-in, esta pantalla no debe fingir que
 * consulta algo. Muestra lo que SI se puede jugar hoy (freerolls y centroll) y dice con
 * claridad que lo demas esta por llegar. Una promesa vacia cuesta mas que una ausencia
 * honesta.
 * ------------------------------------------------------------------
 */
export function Tournaments({ onBack, onNavigate }: Props) {
  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Torneos" onBack={onBack} />

      <div
        className="rounded-2xl p-4 mb-5"
        style={{
          background:
            'linear-gradient(135deg, rgba(155,89,182,0.16) 0%, rgba(15,15,26,0.6) 100%)',
          border: '1px solid rgba(155,89,182,0.35)',
        }}
      >
        <p className="text-sm font-bold text-white mb-1">
          Torneos multi-mesa, 7 por mesa
        </p>
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          Los jugadores se reparten en mesas de 7 y las mesas se fusionan hasta
          la final. Las ciegas suben por niveles y el premio se reparte entre las
          últimas posiciones.
        </p>
      </div>

      <SectionLabel>Disponible ahora</SectionLabel>

      <div className="space-y-2.5 mb-6">
        <button
          onClick={() => onNavigate('freeroll')}
          className="card w-full flex items-center gap-4 text-left hover:border-[#ffd700] transition-all"
        >
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 text-xl"
            style={{
              background: 'linear-gradient(135deg, #ffd700 0%, #e6a800 100%)',
            }}
          >
            🎁
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Freeroll horario</p>
            <p className="text-[11px] text-[#a0a0b0]">
              Gratis · uno cada hora · premio en saldo de promoción
            </p>
          </div>
          <span className="text-[#a0a0b0]">→</span>
        </button>

        <button
          onClick={() => onNavigate('centroll')}
          className="card w-full flex items-center gap-4 text-left hover:border-[#e67e22] transition-all"
        >
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 text-xl"
            style={{
              background: 'linear-gradient(135deg, #e67e22 0%, #d35400 100%)',
            }}
          >
            ⚡
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Centroll</p>
            <p className="text-[11px] text-[#a0a0b0]">
              Entrada de 0,01 USDT · arranca al llenarse
            </p>
          </div>
          <span className="text-[#a0a0b0]">→</span>
        </button>
      </div>

      <SectionLabel>Próximamente</SectionLabel>

      <div className="card flex items-center gap-4 mb-6 opacity-70">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 text-xl"
          style={{ background: '#2a2a4a' }}
        >
          🏆
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-white">
            Torneos con buy-in y garantizado
          </p>
          <p className="text-[11px] text-[#a0a0b0]">
            Programados, con ciegas por niveles y premio fijo
          </p>
        </div>
        <span className="badge badge-warning">Pronto</span>
      </div>

      <div className="card">
        <SectionLabel>Cómo se reparte</SectionLabel>
        <ul className="text-xs text-[#a0a0b0] space-y-1.5 leading-relaxed">
          <li>
            • <span className="text-white">Freeroll</span>: 50% / 30% / 20% entre
            los tres primeros.
          </li>
          <li>
            • <span className="text-white">Cash</span>: el 5% de rake de cada
            bote; el resto vuelve a los jugadores.
          </li>
          <li>
            • Los premios de freeroll van a saldo de promoción: se juegan y se
            desbloquean 1 de cada 10.
          </li>
        </ul>
      </div>
    </div>
  );
}
