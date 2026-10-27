import { PageHeader } from '../components/Layout';

/**
 * OFERTA DE CODIGO FUENTE (AGPL-3.0)
 * ==================================
 *
 * El articulo 13 de la AGPL-3.0 exige que quien use una version modificada
 * del programa a traves de una red ofrezca a esos usuarios el codigo fuente
 * correspondiente. Esta pantalla es esa oferta, visible desde la propia app.
 *
 * El enlace apunta al repositorio del proyecto. Si en el futuro se despliega
 * una version con cambios que no estan en la rama publica, esta pagina y la
 * copia ofrecida tienen que actualizarse a la vez: no basta con decir que el
 * codigo esta disponible.
 */

const REPOSITORIO = 'https://github.com/h4xX311/cubapoker-telegram';
const LICENCIA = `${REPOSITORIO}/blob/main/LICENSE`;
const ATRIBUCIONES = `${REPOSITORIO}/blob/main/NOTICE.md`;
const POKERTH = 'https://github.com/pokerth/pokerth';

interface Props {
  onBack: () => void;
}

export function Source({ onBack }: Props) {
  return (
    <div>
      <PageHeader title="Código fuente" onBack={onBack} />

      <div className="p-4 pb-10 animate-fadeIn">
        <div className="card mb-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚖️</span>
            <div>
              <p className="text-sm font-bold text-white mb-1">
                CubaPoker es software libre
              </p>
              <p className="text-xs text-[#a0a0b0] leading-relaxed">
                La aplicación se distribuye bajo la licencia{' '}
                <strong className="text-white">
                  GNU Affero General Public License, versión 3 (AGPL-3.0)
                </strong>
                . Puedes ejecutarla, estudiarla, modificarla y redistribuirla con
                las condiciones de esa licencia.
              </p>
            </div>
          </div>
        </div>

        <div className="card mb-4">
          <p className="text-sm font-bold text-white mb-2">
            Oferta de código fuente
          </p>
          <p className="text-xs text-[#a0a0b0] leading-relaxed mb-3">
            El código fuente completo de esta versión, incluidas las
            modificaciones, está disponible en el repositorio del proyecto. Si
            has recibido el servicio a través de la red, puedes descargar la
            versión correspondiente desde ahí.
          </p>

          <a
            href={REPOSITORIO}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary w-full py-3 text-sm mb-2"
          >
            Abrir repositorio en GitHub
          </a>

          <div className="grid grid-cols-2 gap-2">
            <a
              href={LICENCIA}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-outline py-2 text-[11px]"
            >
              Texto de la licencia
            </a>
            <a
              href={ATRIBUCIONES}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-outline py-2 text-[11px]"
            >
              Atribuciones
            </a>
          </div>
        </div>

        <div className="card mb-4">
          <p className="text-sm font-bold text-white mb-2">PokerTH</p>
          <p className="text-xs text-[#a0a0b0] leading-relaxed">
            Parte de la lógica de juego y de la inteligencia de los jugadores
            está inspirada en{' '}
            <a
              href={POKERTH}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#00d26a] underline"
            >
              PokerTH
            </a>
            , también bajo AGPL-3.0. Los créditos y las modificaciones están
            documentados en el archivo de atribuciones del repositorio.
          </p>
        </div>

        <p className="text-[10px] text-[#6c6c80] leading-relaxed text-center">
          El programa se distribuye sin garantía alguna. CubaPoker es un juego de
          práctica y entretenimiento; no es un servicio de apuestas regulado.
        </p>
      </div>
    </div>
  );
}
