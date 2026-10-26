export { TimeoutProver } from './proof-pool';

/** Only the private Durable Object binding serves proof requests. */
export default {
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler;
