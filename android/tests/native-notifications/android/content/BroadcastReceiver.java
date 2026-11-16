package android.content;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public abstract class BroadcastReceiver {
    public final AtomicInteger goAsyncCalls = new AtomicInteger();
    public final AtomicInteger finishCalls = new AtomicInteger();
    public volatile CountDownLatch finishLatch = new CountDownLatch(0);

    public abstract void onReceive(Context context, Intent intent);

    public PendingResult expectAsync() {
        finishLatch = new CountDownLatch(1);
        return null;
    }

    public boolean awaitFinish(long timeoutMs) throws InterruptedException {
        return finishLatch.await(timeoutMs, TimeUnit.MILLISECONDS);
    }

    public final PendingResult goAsync() {
        goAsyncCalls.incrementAndGet();
        return new PendingResult();
    }

    public class PendingResult {
        public final void finish() {
            finishCalls.incrementAndGet();
            finishLatch.countDown();
        }
    }
}
