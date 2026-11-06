import ObserverApp from '@/components/ObserverApp';
import { getLang } from '@/i18n/server';
export default async function ObservePage() { return <ObserverApp language={await getLang()} />; }
