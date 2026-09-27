import {PageReady} from '@/components/navigation';
import {Signatures} from '@/components/public/catalog';
import {Heading} from '@/components/ui';
import {publicDb,dbError} from '@/server/db';
import {readSignatures} from '@/server/read';
export const metadata={title:'시그풍'};
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){const input=await searchParams,params=new URLSearchParams(Object.entries(input).filter(([,v])=>v!==undefined) as [string,string][]);const [initial,categories]=await Promise.all([readSignatures(params),publicDb().from('signatures').select('category').eq('is_visible',true).limit(1000)]);dbError(categories.error);return <><PageReady path="/signatures"/><><Heading>시그풍</Heading><Signatures initial={initial} query={params.toString()} categories={[...new Set((categories.data||[]).map(x=>x.category).filter(Boolean))]}/></></>}
