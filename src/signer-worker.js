// Signs approvals off the review window's main thread: SLH-DSA signing takes about a
// second, which would otherwise freeze the window. Each message carries the intent bytes
// and a one-time copy of the owner secret, zeroed here once the signature is made.
import { signApproval } from 'quantum-seal-wallet/approval';

self.onmessage = ({ data: { id, bytes, secret } }) => {
  try {
    self.postMessage({ id, approval: signApproval(bytes, secret, 0) });
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error) });
  } finally {
    secret.fill(0);
  }
};
