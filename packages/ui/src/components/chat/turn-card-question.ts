import { ASK_USER_QUESTION_TOOL_NAME } from './AskUserQuestionCard'
import type { ActivityItem } from './turn-card-shared'

export function isRenderableQuestion(activity: ActivityItem): boolean {
  return activity.toolName === ASK_USER_QUESTION_TOOL_NAME
    && Array.isArray(activity.toolInput?.questions)
    && activity.toolInput.questions.length > 0
    && activity.toolInput.questions.every(question => {
      if (!question || typeof question !== 'object') return false
      const { options, question: text } = question as Record<string, unknown>
      return typeof text === 'string'
        && Array.isArray(options)
        && options.length > 0
        && options.every(option => {
          return !!option
            && typeof option === 'object'
            && typeof (option as Record<string, unknown>).label === 'string'
        })
    })
}
