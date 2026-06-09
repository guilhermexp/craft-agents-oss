import { LazyMotion, m, domAnimation } from 'motion/react'
import { CraftAgentsSymbol } from './icons/CraftAgentsSymbol'

interface SplashScreenProps {
  isExiting: boolean
  onExitComplete?: () => void
}

/**
 * SplashScreen - Shows Craft symbol during app initialization
 *
 * Displays centered symbol on app background, fades out when app is fully ready.
 * On exit, the symbol scales up and fades out quickly while the background fades slower.
 */
export function SplashScreen({ isExiting, onExitComplete }: SplashScreenProps) {
  return (
    <LazyMotion features={domAnimation}>
      <m.div
        className="fixed inset-0 z-splash flex items-center justify-center bg-background"
        initial={{ opacity: 1 }}
        animate={{ opacity: isExiting ? 0 : 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        onAnimationComplete={() => {
          if (isExiting && onExitComplete) {
            onExitComplete()
          }
        }}
      >
        <m.div
          initial={{ scale: 1.5, opacity: 1 }}
          animate={{
            scale: isExiting ? 3 : 1.5,
            opacity: isExiting ? 0 : 1
          }}
          transition={{
            duration: 0.2,
            ease: [0.16, 1, 0.3, 1] // Exponential out curve
          }}
        >
          <CraftAgentsSymbol className="h-8 text-accent" />
        </m.div>
      </m.div>
    </LazyMotion>
  )
}
