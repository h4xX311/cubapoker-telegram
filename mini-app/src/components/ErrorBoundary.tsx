import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  /** Se guarda el mensaje original, que es lo unico que sirve para arreglarlo. */
  detalle: string[];
}

/**
 * Red de seguridad del render.
 *
 * ------------------------------------------------------------------
 * POR QUE HACE FALTA
 *
 * Sin esto, si un componente revienta al pintar, React desmonta el arbol entero y la
 * pantalla se queda EN BLANCO. Sin mensaje, sin error, sin rastro: solo una pagina vacia.
 *
 * Y en este proyecto esa pantalla en blanco es especialmente traicionera, porque hay al
 * menos cuatro motivos distintos que la producen y ninguno se ve desde fuera:
 *
 *   - un 404 de la API (mesa que ya no existe)
 *   - un 500 porque el backend no esta arrancado
 *   - un dato que el servidor no manda y el render da por hecho
 *   - una excepcion al pintar la mesa
 *
 * Los cuatro se ven IGUALES: nada. Asi que no hay forma de distinguirlos ni de saber por
 * donde empezar a mirar. Ese fue el caso real: la mesa no se veia, los botones
 * respondian, y no habia ninguna pista de si era la API, el servidor o el render.
 *
 * ------------------------------------------------------------------
 * QUE MUESTRA
 *
 * El mensaje del error y la pila, no un "algo salio mal". Un fallo de render casi siempre
 * es un campo que llego `undefined` donde el codigo hace `algo.map()` o `algo.toFixed()`,
 * y la pila dice exactamente cual. Sin eso hay que adivinar.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, detalle: [] };

  static getDerivedStateFromError(error: Error): State {
    return {
      error,
      detalle: [
        error.message,
        ...(error.stack ?? '')
          .split('\n')
          .slice(1, 6)
          .map((l) => l.trim()),
      ].filter(Boolean),
    };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // En consola sale el error completo, con la cadena de componentes. Es lo que se mira
    // para arreglarlo.
    console.error('[cubapoker] fallo al pintar:', error, info?.componentStack);
  }

  render() {
    const { error, detalle } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#0a0a14',
          color: '#fff',
          padding: '20px',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h1 style={{ fontSize: '18px', margin: '0 0 8px' }}>La pantalla no se pudo pintar</h1>
        <p style={{ color: '#a0a0b0', fontSize: '13px', margin: '0 0 16px' }}>
          Esto no es un fallo del servidor: es un fallo al pintar. El detalle de abajo dice
          exactamente qué.
        </p>

        <pre
          style={{
            background: '#16213e',
            border: '1px solid #2a2a4a',
            borderRadius: '8px',
            padding: '12px',
            fontSize: '11px',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
            color: '#ffd700',
          }}
        >
          {detalle.join('\n')}
        </pre>

        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: '16px',
            padding: '10px 20px',
            borderRadius: '8px',
            border: 'none',
            background: '#00d26a',
            color: '#06110a',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Recargar
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;