import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Brain, Key, Monitor } from "lucide-react"
import { CraftAgentsSymbol } from "@/components/icons/CraftAgentsSymbol"
import { StepFormLayout } from "./primitives"

import claudeIcon from "@/assets/provider-icons/claude.svg"
import openaiIcon from "@/assets/provider-icons/openai.svg"
import copilotIcon from "@/assets/provider-icons/copilot.svg"

/**
 * The high-level provider choice the user makes on first launch.
 * This maps to one or more ApiSetupMethods downstream.
 */
export type ProviderChoice = 'claude' | 'chatgpt' | 'copilot' | 'hermes' | 'api_key' | 'local'

interface ProviderOption {
  id: ProviderChoice
  name: string
  description: string
  icon: React.ReactNode
  group: 'subscription' | 'runtime' | 'api'
}

const PROVIDER_ICONS: Record<ProviderChoice, React.ReactNode> = {
  claude: <img src={claudeIcon} alt="" className="size-5 rounded-sm" />,
  chatgpt: <img src={openaiIcon} alt="" className="size-5 rounded-sm" />,
  copilot: <img src={copilotIcon} alt="" className="size-5 rounded-sm" />,
  hermes: <Brain className="size-5" />,
  api_key: <Key className="size-5" />,
  local: <Monitor className="size-5" />,
}

interface ProviderSelectStepProps {
  /** Called when the user selects a provider */
  onSelect: (choice: ProviderChoice) => void
  /** Called when the user chooses to skip setup */
  onSkip?: () => void
  errorMessage?: string
}

/**
 * ProviderSelectStep — First screen after install.
 *
 * Welcomes the user and asks them to pick their subscription / auth method.
 * Selecting a card immediately advances to the next step.
 */
export function ProviderSelectStep({ onSelect, onSkip, errorMessage }: ProviderSelectStepProps) {
  const { t } = useTranslation()

  const PROVIDER_OPTIONS: ProviderOption[] = [
    {
      id: 'claude',
      name: t("onboarding.providerSelect.claudeProMax"),
      description: t("onboarding.providerSelect.claudeProMaxDesc"),
      icon: PROVIDER_ICONS.claude,
      group: 'subscription',
    },
    {
      id: 'chatgpt',
      name: t("onboarding.providerSelect.codexChatGPT"),
      description: t("onboarding.providerSelect.codexChatGPTDesc"),
      icon: PROVIDER_ICONS.chatgpt,
      group: 'subscription',
    },
    {
      id: 'copilot',
      name: t("onboarding.providerSelect.githubCopilot"),
      description: t("onboarding.providerSelect.githubCopilotDesc"),
      icon: PROVIDER_ICONS.copilot,
      group: 'subscription',
    },
    {
      id: 'hermes',
      name: t("onboarding.providerSelect.hermes"),
      description: t("onboarding.providerSelect.hermesDesc"),
      icon: PROVIDER_ICONS.hermes,
      group: 'runtime',
    },
    {
      id: 'api_key',
      name: t("onboarding.providerSelect.otherProvider"),
      description: t("onboarding.providerSelect.otherProviderDesc"),
      icon: PROVIDER_ICONS.api_key,
      group: 'api',
    },
    {
      id: 'local',
      name: t("onboarding.providerSelect.localModel"),
      description: t("onboarding.providerSelect.localModelDesc"),
      icon: PROVIDER_ICONS.local,
      group: 'runtime',
    },
  ]

  return (
    <StepFormLayout
      iconElement={
        <div className="flex size-16 items-center justify-center">
          <CraftAgentsSymbol className="size-10 text-accent" />
        </div>
      }
      title={t("onboarding.providerSelect.title")}
      description={t("onboarding.providerSelect.description")}
      className="@container max-h-full max-w-[42rem] overflow-y-auto px-1"
    >
      <div className="space-y-4">
        {errorMessage ? (
          <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}
        {(['subscription', 'runtime', 'api'] as const).map((group) => (
          <section key={group} aria-labelledby={`provider-group-${group}`}>
            <h2
              id={`provider-group-${group}`}
              className="mb-2 text-xs font-medium text-muted-foreground"
            >
              {t(`onboarding.providerSelect.group.${group}`)}
            </h2>
            <div className="grid grid-cols-1 gap-2 @[36rem]:grid-cols-2">
              {PROVIDER_OPTIONS.filter((option) => option.group === group).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onSelect(option.id)}
                  className={cn(
                    "flex min-h-24 w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    option.id === 'claude' || option.id === 'chatgpt'
                      ? "border-accent/30 bg-accent/[0.06] shadow-minimal hover:bg-accent/10"
                      : "border-border/50 bg-foreground-2 shadow-minimal hover:bg-foreground/[0.03]",
                  )}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    {option.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{option.name}</span>
                    <p className="text-xs text-muted-foreground">{option.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      {onSkip ? (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={onSkip}
            className="min-h-11 rounded-md px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("onboarding.providerSelect.setupLater")}
          </button>
        </div>
      ) : null}
    </StepFormLayout>
  )
}
