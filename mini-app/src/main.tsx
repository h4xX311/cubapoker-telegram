import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

// ------------------------------------------------------------------
// EL ERRORBOUNDARY ENVUELVE TODA LA APLICACION, Y VA FUERA DEL STRICTMODE
//
// Sin el, si un componente revienta al pintar, React desmonta el arbol entero y la
// pantalla se queda en blanco: sin mensaje, sin error, sin rastro. Y hay varios motivos
// distintos que producen esa misma pantalla en blanco, asi que no hay forma de saber por
// donde mirar.
//
// Va fuera del `StrictMode` a proposito: el `StrictMode` monta dos veces en desarrollo
// para encontrar efectos mal hechos, y su error tambien tumba el arbol. Si el fallo ocurre
// ahi, sin este envoltorio el error se pierde antes de llegar a ningun sitio.
//
// Con el, cualquier fallo de render se ve: pantalla con el mensaje y la pila. Que es lo
// unico que permite arreglarlo en vez de adivinarlo.
// ------------------------------------------------------------------
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </ErrorBoundary>,
);