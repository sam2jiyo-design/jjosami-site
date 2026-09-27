import {PageReady} from '@/components/navigation';
import {Obligations} from '@/components/public/obligations';
import {Heading} from '@/components/ui';
import {readAccounts} from '@/server/read';
import {dbError,publicDb} from '@/server/db';
export const metadata={title:'업보'};
export default async function Page(){const [initial,types]=await Promise.all([readAccounts(new URLSearchParams()),publicDb().from('obligation_types').select('id,name').eq('active',true).order('name')]);dbError(types.error);return <><PageReady path="/obligations"/><><Heading>업보</Heading><Obligations initial={initial} types={types.data||[]}/></></>}
