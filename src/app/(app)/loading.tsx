import { Skeleton } from '@/ui/Skeleton';

/** Shown only while the server builds a page in this section; real content replaces it as soon as it is ready. */
export default function Loading() {
  return <Skeleton label="Loading" shape="signal" rows={5} />;
}
