// Mobile gesture support: pull-to-refresh and swipe-back navigation.

const PULL_THRESHOLD = 60;
const SWIPE_EDGE_WIDTH = 30;
const SWIPE_THRESHOLD = 100;

/**
 * Enable pull-to-refresh on a scroll container.
 * @param {HTMLElement} scrollContainer - Element that scrolls (card body)
 * @param {() => Promise<void>} onRefresh - Async callback when refresh is triggered
 * @returns {() => void} Cleanup function
 */
export function enablePullToRefresh(scrollContainer, onRefresh) {
    let startY = 0;
    let pulling = false;
    let indicator = null;

    function createIndicator() {
        indicator = document.createElement('div');
        indicator.className = 'pull-indicator';
        indicator.textContent = '\u2193';
        scrollContainer.parentElement.insertBefore(indicator, scrollContainer);
        return indicator;
    }

    function onTouchStart(e) {
        if (scrollContainer.scrollTop > 0) return;
        startY = e.touches[0].clientY;
        pulling = true;
    }

    function onTouchMove(e) {
        if (!pulling) return;
        const delta = e.touches[0].clientY - startY;
        if (delta < 0) { pulling = false; return; }
        if (delta > 10) {
            if (!indicator) createIndicator();
            const progress = Math.min(delta / 80, 1);
            indicator.style.transform = `translateY(${Math.min(delta * 0.5, 40)}px)`;
            indicator.style.opacity = String(progress);
            if (delta > PULL_THRESHOLD) {
                indicator.classList.add('pull-ready');
            } else {
                indicator.classList.remove('pull-ready');
            }
        }
    }

    function onTouchEnd() {
        if (!pulling) return;
        pulling = false;
        if (indicator?.classList.contains('pull-ready')) {
            indicator.classList.add('pull-refreshing');
            onRefresh().finally(() => {
                if (indicator) { indicator.remove(); indicator = null; }
            });
        } else {
            if (indicator) { indicator.remove(); indicator = null; }
        }
    }

    scrollContainer.addEventListener('touchstart', onTouchStart, { passive: true });
    scrollContainer.addEventListener('touchmove', onTouchMove, { passive: true });
    scrollContainer.addEventListener('touchend', onTouchEnd);

    return () => {
        scrollContainer.removeEventListener('touchstart', onTouchStart);
        scrollContainer.removeEventListener('touchmove', onTouchMove);
        scrollContainer.removeEventListener('touchend', onTouchEnd);
        if (indicator) { indicator.remove(); indicator = null; }
    };
}

/**
 * Enable swipe-back gesture from the left edge.
 * @param {HTMLElement} element - The view container element
 * @param {() => void} onBack - Callback when swipe-back is triggered
 * @returns {() => void} Cleanup function
 */
export function enableSwipeBack(element, onBack) {
    let startX = 0;
    let startY = 0;
    let swiping = false;
    let indicator = null;

    function createIndicator() {
        indicator = document.createElement('div');
        indicator.className = 'swipe-back-indicator';
        document.body.appendChild(indicator);
        return indicator;
    }

    function onTouchStart(e) {
        const touch = e.touches[0];
        if (touch.clientX > SWIPE_EDGE_WIDTH) return;
        startX = touch.clientX;
        startY = touch.clientY;
        swiping = true;
    }

    function onTouchMove(e) {
        if (!swiping) return;
        const dx = e.touches[0].clientX - startX;
        const dy = Math.abs(e.touches[0].clientY - startY);

        // Cancel if vertical movement is dominant
        if (dy > dx) { swiping = false; return; }

        if (dx > 20) {
            if (!indicator) createIndicator();
            const progress = Math.min(dx / SWIPE_THRESHOLD, 1);
            indicator.style.opacity = String(progress * 0.7);
        }
    }

    function onTouchEnd(e) {
        if (!swiping) { cleanup(); return; }
        swiping = false;
        const dx = e.changedTouches[0].clientX - startX;
        cleanup();
        if (dx > SWIPE_THRESHOLD) {
            onBack();
        }
    }

    function cleanup() {
        if (indicator) { indicator.remove(); indicator = null; }
    }

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('touchend', onTouchEnd);

    return () => {
        element.removeEventListener('touchstart', onTouchStart);
        element.removeEventListener('touchmove', onTouchMove);
        element.removeEventListener('touchend', onTouchEnd);
        cleanup();
    };
}
