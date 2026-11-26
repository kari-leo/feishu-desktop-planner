import { createRoot } from 'react-dom/client';
import { Schedule } from './schedule';
import { Today } from './todo';
import { Settings } from './settings';
import './style.css';

const kind = new URLSearchParams(location.search).get('widget');
createRoot(document.getElementById('app')!).render(kind === 'todo' ? <Today/> : kind === 'settings' ? <Settings/> : <Schedule/>);
