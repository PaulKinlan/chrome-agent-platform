// Minimal single-threaded pthread.h for jq's WASI preview-1 build.
#ifndef _PTHREAD_SHIM_H
#define _PTHREAD_SHIM_H
#include <stddef.h>
typedef unsigned long pthread_key_t;
typedef unsigned long pthread_once_t;
typedef struct { int unused; } pthread_mutex_t;
#define PTHREAD_ONCE_INIT 0UL
#define PTHREAD_MUTEX_INITIALIZER { 0 }
int pthread_key_create(pthread_key_t *, void (*)(void *));
int pthread_setspecific(pthread_key_t, const void *);
void *pthread_getspecific(pthread_key_t);
int pthread_once(pthread_once_t *, void (*)(void));
int pthread_mutex_init(pthread_mutex_t *, const void *);
int pthread_mutex_lock(pthread_mutex_t *);
int pthread_mutex_unlock(pthread_mutex_t *);
int pthread_mutex_destroy(pthread_mutex_t *);
#endif
