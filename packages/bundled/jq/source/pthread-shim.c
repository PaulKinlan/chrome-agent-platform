#include "pthread.h"
static void *_tls_slots[64];
static int _tls_key_count = 0;
int pthread_key_create(pthread_key_t *key, void (*dtor)(void *)) {
  (void)dtor; if (_tls_key_count >= 64) return -1; *key = _tls_key_count++; return 0;
}
int pthread_setspecific(pthread_key_t key, const void *value) {
  if (key >= 64) return -1; _tls_slots[key] = (void *)value; return 0;
}
void *pthread_getspecific(pthread_key_t key) {
  if (key >= 64) return 0; return _tls_slots[key];
}
int pthread_once(pthread_once_t *once, void (*init)(void)) {
  if (once == 0 || init == 0) return -1; if (*once == 0) { *once = 1; init(); } return 0;
}
int pthread_mutex_init(pthread_mutex_t *m, const void *a) { (void)m;(void)a; return 0; }
int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
