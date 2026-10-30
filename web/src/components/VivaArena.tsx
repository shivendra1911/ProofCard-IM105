import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Briefcase,
  Zap, 
  Clock, 
  CheckCircle, 
  XCircle, 
  ArrowRight, 
  RefreshCw,
  RotateCcw,
  Award,
  Terminal,
  Mic,
  MicOff,
  Users,
  ShieldCheck,
  ShieldAlert,
  Lock,
  AlertTriangle,
  Code
} from 'lucide-react';
import { CandidateProfile, VivaQuestion, ComplexFunction } from '../types';
import { ensureTenVivaQuestions } from '../utils/vivaQuestionGenerator';
import { 
  evaluateVivaAnswer, 
  generateMoreVivaQuestions, 
  checkAiTolerance, 
  fetchPromptingTemplates, 
  PromptingTemplate, 
  AIToleranceResult 
} from '../services/api';

interface VivaArenaProps {
  candidate: CandidateProfile | null;
  onUpdateVivaScore: (newScore: number) => void;
  onNavigateToTab: (tab: string) => void;
  onSelectCandidate?: (candidate: CandidateProfile) => void;
  cohort?: CandidateProfile[];
  portalMode?: 'candidate' | 'admin';
}

type SpeechRecognitionResultEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionErrorEventLike = { error?: string };

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
}

type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike;


export const calculateQuestionTime = (question: VivaQuestion | undefined): { seconds: number; rationale: string } => {
  if (!question) return { seconds: 60, rationale: 'Standard 60s response window.' };
  const words = (question.question || '').split(/\s+/).filter(Boolean).length;
  const readingSeconds = Math.max(10, Math.ceil((words / 180) * 60));
  const conceptsCount = question.expected_concepts?.length || 2;
  const conceptsSeconds = conceptsCount * 15;
  const diff = (question.difficulty || '').toLowerCase();
  const diffBonus = diff === 'hard' ? 25 : diff === 'medium' ? 15 : 5;
  const rawTotal = readingSeconds + conceptsSeconds + diffBonus;
  const seconds = Math.max(45, Math.min(120, rawTotal));
  const rationale = `${seconds}s allocated: ${readingSeconds}s reading (${words} words) + ${conceptsSeconds}s formulation (${conceptsCount} concepts) + ${diffBonus}s ${question.difficulty || 'medium'} difficulty buffer.`;
  return { seconds, rationale };
};

export const VivaArena: React.FC<VivaArenaProps> = ({
  candidate,
  onUpdateVivaScore,
  onNavigateToTab,
  onSelectCandidate,
  cohort = [],
  portalMode = 'candidate',
}) => {
  // If no candidate is active, show clean high-tech empty state
  if (!candidate) {
    return (
      <div className="max-w-4xl mx-auto py-16 px-4 text-center">
        <div className="p-8 sm:p-12 rounded-2xl bg-white border border-gray-200 shadow-sm">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-50 border border-gray-200 flex items-center justify-center">
            <Zap className="w-8 h-8 text-[#4b5563]" />
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#111827] mb-2 font-sans">
            No Candidate Selected for Viva
          </h2>
          <p className="text-sm text-gray-600 max-w-md mx-auto mb-6">
            Scan a live repository in the Code Ingestion Scanner to extract Abstract Syntax Trees and generate candidate-specific technical viva questions.
          </p>
          <button
            onClick={() => onNavigateToTab('ingestion')}
            className="btn-primary text-xs flex items-center gap-2 px-6 py-3.5 mx-auto shadow-lg cursor-pointer font-bold"
          >
            <span>Go to Ingestion Scanner</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  const isCandidateNonTech = Boolean(
    candidate?.stream_track === 'NON_TECHNICAL' || 
    /mba|business|product|marketing|recruiter|hr|design|sales|operations/i.test(candidate?.project_type || '')
  );

  const initialSetup = useMemo(
    () => isCandidateNonTech ? { questions: candidate?.viva_questions || [], complexFunctions: [] } : ensureTenVivaQuestions(candidate),
    [candidate?.candidate_id, isCandidateNonTech]
  );
  const [isVivaActive, setIsVivaActive] = useState<boolean>(false);
  const [questions, setQuestions] = useState<VivaQuestion[]>(initialSetup.questions);
  const [complexFunctions, setComplexFunctions] = useState<ComplexFunction[]>(initialSetup.complexFunctions);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(60);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [userAnswer, setUserAnswer] = useState('');
  const [evaluatedAnswers, setEvaluatedAnswers] = useState<Record<number, any>>({});
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isGeneratingMore, setIsGeneratingMore] = useState(false);
  const [showCohortRoster, setShowCohortRoster] = useState(false);
  const [selectedFuncIndex, setSelectedFuncIndex] = useState<number>(0);

  // Enterprise AI Prompting Policy & Tolerance Gate State
  const [promptTemplates, setPromptTemplates] = useState<PromptingTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('balanced-copilot');
  const [toleranceLimit, setToleranceLimit] = useState<number>(35);
  const [liveToleranceResult, setLiveToleranceResult] = useState<AIToleranceResult | null>(null);
  const [isAuditingTolerance, setIsAuditingTolerance] = useState<boolean>(false);

  // Load templates on mount
  useEffect(() => {
    fetchPromptingTemplates().then(res => {
      if (res?.templates?.length) {
        setPromptTemplates(res.templates);
        const def = res.templates.find(t => t.id === res.default_template_id) || res.templates[1];
        if (def) {
          setSelectedTemplateId(def.id);
          setToleranceLimit(def.max_ai_limit_percent);
        }
      }
    });
  }, []);

  const activeTemplate = promptTemplates.find(t => t.id === selectedTemplateId) || {
    id: 'balanced-copilot',
    name: 'Balanced Copilot (Standard SaaS)',
    max_ai_limit_percent: 35,
    description: 'Permits standard Copilot/ChatGPT scaffolding up to 35%. Candidate must explain architectural trade-offs.',
    allowed_categories: ['Scaffolding', 'CSS/Tailwind Styling', 'CRUD Routes'],
    prohibited_categories: ['System Architecture', 'Prompt Injection Bypasses'],
    penalty_action: 'PROMPT_FOR_ARCHITECTURAL_DEFENSE'
  };

  const handleTemplateChange = (tmplId: string) => {
    setSelectedTemplateId(tmplId);
    const tmpl = promptTemplates.find(t => t.id === tmplId);
    if (tmpl) {
      setToleranceLimit(tmpl.max_ai_limit_percent);
    }
    setLiveToleranceResult(null);
  };

  const handleAuditAiTolerance = async () => {
    if (!userAnswer.trim()) return;
    setIsAuditingTolerance(true);
    try {
      const res = await checkAiTolerance(
        userAnswer,
        toleranceLimit,
        candidate.name,
        currentQuestionIndex,
        selectedTemplateId
      );
      setLiveToleranceResult(res);
    } catch (e) {
      console.warn('AI tolerance audit error:', e);
    } finally {
      setIsAuditingTolerance(false);
    }
  };



  // Enterprise Anomaly & Plagiarism Viva Gating (Threshold: 30%)

  const cloneScore = candidate.is_clone 

    ? Math.round((candidate.matched_tutorial?.similarity_score || 0.7) * 100) 

    : 0;

  const authenticityScore = candidate.authenticity_score ?? 100;

  const anomalyScore = Math.max(

    cloneScore,

    100 - authenticityScore,

    (candidate.is_prompt_injected || candidate.security_scan?.is_prompt_injected) ? 90 : 0,

    candidate.anomaly_score || 0

  );

  const isVivaBlocked = Boolean(

    candidate.viva_blocked ?? (

      anomalyScore > 30 || 

      candidate.is_prompt_injected || 

      candidate.security_scan?.is_prompt_injected || 

      candidate.is_clone

    )

  );

  const isNonTech = Boolean(
    candidate.stream_track === 'NON_TECHNICAL' || 
    /mba|business|product|marketing|recruiter|hr|design|sales|operations/i.test(candidate.project_type || '')
  );

  // Web Speech API state
  const [isListening, setIsListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState<boolean | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [interimTranscript, setInterimTranscript] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceBaseTextRef = useRef('');
  const finalTranscriptRef = useRef('');
  const shouldKeepListeningRef = useRef(false);

  const stopVoiceDefense = (abort = false) => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setIsListening(false);
      setInterimTranscript('');
      shouldKeepListeningRef.current = false;
      return;
    }
    shouldKeepListeningRef.current = false;
    try {
      abort ? recognition.abort() : recognition.stop();
    } catch {
      // The browser may throw if recognition already ended.
    }
    recognitionRef.current = null;
    setIsListening(false);
    setInterimTranscript('');
  };

  useEffect(() => {
    const speechWindow = window as Window & {
      SpeechRecognition?: SpeechRecognitionConstructorLike;
      webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
    };
    setVoiceSupported(Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition));
    return () => stopVoiceDefense(true);
  }, []);

  // Timer countdown and auto-submission on expiry
  useEffect(() => {
    let timer: any = null;
    if (isTimerRunning && timeLeft > 0) {
      timer = setInterval(() => {
        setTimeLeft(prev => prev - 1);
      }, 1000);
    } else if (timeLeft === 0 && isTimerRunning) {
      setIsTimerRunning(false);
      handleAutoSubmitOnExpiry();
    }
    return () => clearInterval(timer);
  }, [isTimerRunning, timeLeft]);

  // Dynamic timer reset when question changes
  useEffect(() => {
    stopVoiceDefense(true);
    setInterimTranscript('');
    const targetQ = questions[currentQuestionIndex];
    const { seconds } = calculateQuestionTime(targetQ);
    setTimeLeft(seconds);
    setIsTimerRunning(isVivaActive && !evaluatedAnswers[currentQuestionIndex]);
    setUserAnswer('');
  }, [currentQuestionIndex, questions, isVivaActive]);

  const defaultNonTechQuestions: VivaQuestion[] = useMemo(() => [
    {
      question_id: 'biz_q1',
      function_name: 'saas_onboarding_roi',
      file: 'strategy/business_case.pdf',
      line_number: 1,
      question: `In your case initiative '${candidate.project_name || 'Strategic Portfolio'}', how did you measure ROI and attribute the quantified business impact against baseline churn?`,
      expected_concepts: ['ROI attribution', 'Unit economics', 'Payback period', 'Cohort retention', 'LTV to CAC ratio'],
      difficulty: 'hard',
      mock_answer: 'We isolated organic lift with a 50/50 randomized holdout and measured incremental margin contribution against customer acquisition cost.',
      score: 0,
      feedback: 'Pending oral case evaluation.'
    },
    {
      question_id: 'biz_q2',
      function_name: 'stakeholder_priority_conflict',
      file: 'strategy/roadmap_prioritization.pdf',
      line_number: 1,
      question: 'Engineering wants to spend 2 sprints refactoring tech debt, while Enterprise Sales demands 3 custom client features to close the quarterly quota. What structured framework do you apply to resolve this deadlock?',
      expected_concepts: ['RICE / Value vs Effort scoring', 'Capacity allocation (70/20/10)', 'Opportunity cost evaluation', 'Executive stakeholder negotiation'],
      difficulty: 'medium',
      mock_answer: 'I implement a 70/20/10 capacity allocation where 20% of engineering bandwidth is protected for critical technical debt, and rank sales requests by net ARR impact.',
      score: 0,
      feedback: 'Pending oral case evaluation.'
    },
    {
      question_id: 'biz_q3',
      function_name: 'growth_triage_protocol',
      file: 'growth/funnel_diagnostics.xlsx',
      line_number: 1,
      question: 'If your primary customer acquisition channel or core conversion funnel dropped 30% month-over-month overnight, walk through your systematic 48-hour diagnostic protocol.',
      expected_concepts: ['Tracking/tag instrumentation audit', 'Step-level funnel segmentation', 'Browser/device cohort breakdown', '24-hour triage hypothesis'],
      difficulty: 'hard',
      mock_answer: 'Step 1: Check telemetry tags to ensure tracking did not break. Step 2: Segment drop-off by channel, device, and browser. Step 3: Inspect step-level conversion. Step 4: Formulate a 24-hr hotfix hypothesis.',
      score: 0,
      feedback: 'Pending oral case evaluation.'
    }
  ], [candidate.project_name]);

  // Sync questions when candidate changes or stream changes
  useEffect(() => {
    stopVoiceDefense(true);
    setVoiceError(null);
    setIsVivaActive(false);
    setIsTimerRunning(false);
    if (isNonTech) {
      const hasCodingQuestion = candidate.viva_questions?.some(q => 
        q.question.includes('train_hybrid_ensemble') || 
        q.question.includes('VotingClassifier') || 
        q.question.includes('Soft voting') || 
        q.question.includes('function') ||
        q.file?.endsWith('.py') ||
        q.file?.endsWith('.ts')
      );
      if (!candidate.viva_questions || candidate.viva_questions.length === 0 || hasCodingQuestion) {
        setQuestions(defaultNonTechQuestions);
      } else {
        setQuestions(candidate.viva_questions);
      }
    } else {
      const setup = ensureTenVivaQuestions(candidate);
      setQuestions(setup.questions);
      setComplexFunctions(setup.complexFunctions);
    }
    setCurrentQuestionIndex(0);
    setEvaluatedAnswers({});
  }, [candidate.candidate_id, isNonTech, defaultNonTechQuestions]);

  const handleInsertSampleSpokenAnswer = () => {
    const targetQ = questions[currentQuestionIndex] || questions[0];
    const sample = targetQ?.mock_answer || "In my implementation, I prioritized low-latency asynchronous processing with explicit socket timeout handling, connection pooling, and backpressure management to prevent memory leaks.";
    setUserAnswer(sample);
    setVoiceError(null);
    if (timeLeft === 0) {
      setTimeLeft(60);
      setIsTimerRunning(true);
    }
  };

  const handleRetakeQuestion = () => {
    setEvaluatedAnswers(prev => {
      const next = { ...prev };
      delete next[currentQuestionIndex];
      return next;
    });
    const targetQ = questions[currentQuestionIndex] || questions[0];
    const { seconds } = calculateQuestionTime(targetQ);
    setTimeLeft(seconds || 60);
    setIsTimerRunning(true);
    setUserAnswer('');
    setVoiceError(null);
    setInterimTranscript('');
    stopVoiceDefense(true);
  };

  const toggleVoiceDefense = async () => {
    // If timer was expired, restore timer for speaking
    if (timeLeft === 0) {
      setTimeLeft(60);
      setIsTimerRunning(true);
    }

    if (isListening) {
      stopVoiceDefense();
      return;
    }

    const speechWindow = window as Window & {
      SpeechRecognition?: SpeechRecognitionConstructorLike;
      webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
    };
    const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setVoiceSupported(false);
      handleInsertSampleSpokenAnswer();
      setVoiceError('Speech recognition is not supported in this browser. Inserted candidate sample voice answer for testing.');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'en-US';
      recognition.maxAlternatives = 1;
      voiceBaseTextRef.current = userAnswer.trim();
      finalTranscriptRef.current = '';
      setInterimTranscript('');
      setVoiceError(null);
      shouldKeepListeningRef.current = true;
      recognitionRef.current = recognition;

      recognition.onstart = () => {
        setIsListening(true);
        setVoiceError(null);
      };

      recognition.onend = () => {
        if (recognitionRef.current === recognition && shouldKeepListeningRef.current) {
          try {
            recognition.start();
            return;
          } catch {
            // Fall through
          }
        }
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
          setIsListening(false);
          setInterimTranscript('');
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') {
          return; // Ignore brief silence and manual aborts
        }
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
          setIsListening(false);
          setInterimTranscript('');
        }
        shouldKeepListeningRef.current = false;
        
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          handleInsertSampleSpokenAnswer();
          setVoiceError('Microphone permission was denied. Inserted candidate sample voice answer so you can evaluate the response.');
        } else {
          setVoiceError(`Microphone notice (${event.error}). You can retry or click "Sample Voice Answer".`);
        }
      };

      recognition.onresult = (event) => {
        let interim = '';
        let finalText = finalTranscriptRef.current;
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result[0]?.transcript || '';
          if (result.isFinal) finalText += transcript;
          else interim += transcript;
        }
        finalTranscriptRef.current = finalText;
        setInterimTranscript(interim.trim());
        const combined = [voiceBaseTextRef.current, finalText.trim()].filter(Boolean).join(' ');
        setUserAnswer(combined);
      };

      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setIsListening(false);
      handleInsertSampleSpokenAnswer();
      setVoiceError('Could not start microphone directly. Inserted candidate sample voice answer for demonstration.');
    }
  };

  const handleGenerateMoreQuestions = async (count: number = 3) => {
    setIsGeneratingMore(true);
    try {
      const newQuestions = await generateMoreVivaQuestions(
        candidate.complex_functions || [],
        count
      );
      if (newQuestions && newQuestions.length > 0) {
        setQuestions(newQuestions);
        setCurrentQuestionIndex(0);
        setEvaluatedAnswers({});
      }
    } catch (e) {
      // fallback
    } finally {
      setIsGeneratingMore(false);
    }
  };

  const handleAutoSubmitOnExpiry = async () => {
    stopVoiceDefense(true);
    const ansText = userAnswer.trim();
    if (!ansText) {
      const evaluation = {
        score: 0,
        demonstrated: [],
        missing: currentQ?.expected_concepts || [],
        feedback: "Time expired without submission! Question auto-assigned 0/10 points.",
        passed: false,
        ai_detection: {
          status: "analyzed",
          classification: "insufficient_text" as const,
          model_version: "hybrid-tfidf-burstiness-v1.2",
          text_length: 0,
          language_supported: true,
          limitations: ["No answer text submitted within allocated time limit."]
        },
        adversarial_injection_detected: false
      };
      const updated = {
        ...evaluatedAnswers,
        [currentQuestionIndex]: evaluation
      };
      setEvaluatedAnswers(updated);
      const keys = Object.keys(updated);
      if (keys.length === questions.length) {
        const total = Object.values(updated).reduce((acc: number, val: any) => acc + val.score, 0);
        const avg = Math.round(total / questions.length);
        onUpdateVivaScore(avg);
      }
      return;
    }
    await handleSubmitAnswer();
  };

  const handleSubmitAnswer = async () => {
    if (!userAnswer.trim()) return;
    setIsEvaluating(true);
    setIsTimerRunning(false);

    try {
      const res = await evaluateVivaAnswer(
        candidate.candidate_id,
        currentQ.question_id || (currentQ as any).id || 'viva_q_1',
        currentQ.question,
        currentQ.expected_concepts || [],
        userAnswer
      );

      const evaluation = {
        score: res.score,
        demonstrated: res.concepts_demonstrated || [],
        missing: res.concepts_missing || [],
        feedback: res.feedback || (res.passed 
          ? 'Strong technical answer demonstrating genuine architectural ownership.' 
          : 'Answer was superficial, off-topic, or nonsensical; missed critical concepts.'),
        passed: res.passed,
        ai_detection: res.ai_detection,
        adversarial_injection_detected: res.adversarial_injection_detected
      };

      const updated = {
        ...evaluatedAnswers,
        [currentQuestionIndex]: evaluation
      };
      setEvaluatedAnswers(updated);
      setIsEvaluating(false);

      const keys = Object.keys(updated);
      if (keys.length === questions.length) {
        const total = Object.values(updated).reduce((acc: number, val: any) => acc + val.score, 0);
        const avg = Math.round(total / questions.length);
        onUpdateVivaScore(avg);
      }
    } catch (e) {
      setIsEvaluating(false);
    }
  };

  const handleNext = () => {
    if (evaluatedAnswers[currentQuestionIndex] === undefined) {
      return;
    }
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
    } else {
      onNavigateToTab('proofcard');
    }
  };

  const currentQ = questions[currentQuestionIndex] || questions[0];
  const isCurrentEvaluated = evaluatedAnswers[currentQuestionIndex] !== undefined;

  // Synchronize snippet tab with the current active question
  useEffect(() => {
    const funcs = complexFunctions.length > 0 ? complexFunctions : (candidate?.complex_functions || []);
    if (funcs.length === 0) return;
    const matchIdx = funcs.findIndex(
      f => f.function_name === currentQ?.function_name || f.file === currentQ?.file
    );
    if (matchIdx !== -1) {
      setSelectedFuncIndex(matchIdx);
    } else if (funcs[currentQuestionIndex]) {
      setSelectedFuncIndex(currentQuestionIndex);
    } else {
      setSelectedFuncIndex(0);
    }
  }, [currentQuestionIndex, currentQ?.function_name, currentQ?.file, complexFunctions, candidate?.complex_functions]);

  // Derived active snippet to display directly below the question
  const activeSnippetFunc = useMemo<ComplexFunction>(() => {
    const funcs = complexFunctions.length > 0 ? complexFunctions : (candidate?.complex_functions || []);
    if (funcs[selectedFuncIndex]) {
      return funcs[selectedFuncIndex];
    }
    const match = funcs.find(f => f.function_name === currentQ?.function_name);
    if (match) return match;
    return {
      file: currentQ?.file || 'src/main.py',
      function_name: currentQ?.function_name || 'core_implementation',
      complexity: 8,
      line_number: currentQ?.line_number || 42,
      snippet: `def ${currentQ?.function_name || 'core_implementation'}():\n    # Implementation logic for ${currentQ?.file || 'src/main.py'}:${currentQ?.line_number || 42}\n    pass`
    };
  }, [complexFunctions, candidate?.complex_functions, selectedFuncIndex, currentQ, currentQuestionIndex]);

  if (!currentQ || questions.length === 0) {
    return (
      <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6">
        <div className="p-8 sm:p-12 rounded-2xl bg-white backdrop-blur-md border border-gray-200 text-center shadow-2xl">
          <ShieldCheck className="w-12 h-12 mx-auto mb-3 text-[#4b5563]" />
          <h1 className="text-xl sm:text-2xl font-bold text-[#111827] mb-2 font-sans">
            Viva Questions Pending
          </h1>
          <p className="text-sm text-gray-700 max-w-lg mx-auto mb-6">
            AST questions can be synthesized directly from this candidate's complex functions ({candidate.complex_functions?.length || 0} detected).
          </p>
          <button
            onClick={() => handleGenerateMoreQuestions(3)}
            disabled={isGeneratingMore}
            className="btn-primary text-xs flex items-center gap-2 px-6 py-3.5 mx-auto shadow-lg cursor-pointer font-bold"
          >
            {isGeneratingMore ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            <span>Synthesize Questions via AST Analysis</span>
          </button>
        </div>
      </div>
    );
  }

  // Real Cohort Stats if present
  const validVivaCandidates = cohort.filter(c => (c.viva_score || 0) > 0 && !c.is_clone);
  const avgCohortViva = validVivaCandidates.length > 0 
    ? (validVivaCandidates.reduce((acc, c) => acc + (c.viva_score || 0), 0) / validVivaCandidates.length).toFixed(1)
    : 'N/A';

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6">
      {/* Top Header Card with Candidate Switcher */}
      <div className="p-6 rounded-2xl mb-6 bg-white border border-gray-200 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <span className="text-xs font-sans font-bold text-[#4b5563] uppercase tracking-wider">
                Verified Code Viva
              </span>

              {/* Candidate Switcher Dropdown (Admin Only) */}
              {portalMode === 'admin' && onSelectCandidate && cohort.length > 0 && (
                <div>
                  <select
                    value={candidate.candidate_id}
                    onChange={(e) => {
                      const found = cohort.find(c => c.candidate_id === e.target.value);
                      if (found) onSelectCandidate(found);
                    }}
                    className="bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1 text-xs text-[#4b5563] font-sans font-bold focus:outline-none cursor-pointer max-w-[200px]"
                  >
                    <option value={candidate.candidate_id}>
                      {candidate.name} ({(candidate.viva_score && candidate.viva_score > 0) ? `${candidate.viva_score}/10` : 'Pending Viva'})
                    </option>
                    {cohort.filter(c => c.candidate_id !== candidate.candidate_id).map(c => (
                      <option key={c.candidate_id} value={c.candidate_id}>
                        {c.name} ({(c.viva_score && c.viva_score > 0) ? `${c.viva_score}/10` : 'Pending Viva'})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <h1 className="text-xl sm:text-2xl font-bold text-[#111827] tracking-tight font-sans flex flex-wrap items-center gap-2">
              <span>{candidate.stream_track === 'NON_TECHNICAL' ? '💼 Executive & Strategy Case Defense Arena' : '⚡ AI Code Defense Arena'}</span>
              <span className="text-sm text-[#4b5563] font-semibold font-mono">
                ({candidate.name})
              </span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                candidate.stream_track === 'NON_TECHNICAL' ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-blue-50 text-blue-700 border-blue-200'
              }`}>
                {candidate.stream_track === 'NON_TECHNICAL' ? 'Non-Technical Track' : 'Technical Track'}
              </span>
            </h1>
          </div>

          {portalMode === 'admin' && cohort.length > 0 && (
            <button
              onClick={() => setShowCohortRoster(!showCohortRoster)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-xs sm:text-sm font-bold text-[#4b5563] hover:bg-red-50 transition cursor-pointer shrink-0"
            >
              <Users className="w-3.5 h-3.5 text-[#4b5563]" />
              <span>{showCohortRoster ? 'Hide Cohort Roster' : `View Candidates (${cohort.length})`}</span>
            </button>
          )}
        </div>
      </div>

      {/* Cohort Viva Roster Drawer (Admin Only) */}
      {portalMode === 'admin' && showCohortRoster && cohort.length > 0 && (
        <div className="mb-6 p-5 rounded-2xl bg-white border border-gray-200 shadow-sm animate-in fade-in">
          <div className="flex items-center justify-between mb-3 text-xs font-sans">
            <span className="text-[#4b5563] font-bold uppercase tracking-wider flex items-center gap-2">
              <Users className="w-4 h-4 text-[#4b5563]" />
              <span>Cohort Viva Ledger ({cohort.length} Candidates)</span>
            </span>
            <span className="font-mono text-gray-600">
              Average Viva Score: <strong className="text-[#111827]">{avgCohortViva} / 10</strong>
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-left text-sm text-gray-800">
              <thead className="bg-gray-50 uppercase font-bold text-xs sm:text-sm text-[#4b5563] border-b border-gray-200">
                <tr>
                  <th className="py-3 px-3">Candidate</th>
                  <th className="py-3 px-3">College</th>
                  <th className="py-3 px-3">Viva Score</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-3 text-right">Switch</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 font-mono text-xs sm:text-sm">
                {cohort.slice(0, 15).map((cand) => (
                  <tr key={cand.candidate_id} className="hover:bg-white/5 transition">
                    <td className="py-3 px-3 text-[#111827] font-sans font-bold">
                      {cand.name}
                    </td>
                    <td className="py-3 px-3 text-[#4b5563]">
                      {cand.college}
                    </td>
                    <td className="py-3 px-3 font-bold text-base">
                      {cand.is_clone ? (
                        <span className="text-red-600 text-xs font-bold">✕ Disqualified</span>
                      ) : (cand.viva_score && cand.viva_score > 0) ? (
                        <span className="text-emerald-700 font-bold">{cand.viva_score} / 10</span>
                      ) : (
                        <span className="text-amber-400 text-xs font-bold">⏳ Awaiting Viva</span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      {(cand.viva_score || 0) >= 7 ? (
                        <span className="text-emerald-700 text-xs sm:text-sm flex items-center gap-1 font-semibold">
                          <CheckCircle className="w-3.5 h-3.5" />
                          Completed Technical Viva
                        </span>
                      ) : (
                        <span className="text-amber-400 text-xs sm:text-sm flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Pending / Borderline
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right">
                      <button
                        onClick={() => {
                          if (onSelectCandidate) onSelectCandidate(cand);
                          setShowCohortRoster(false);
                        }}
                        className="text-xs sm:text-sm text-[#4b5563] hover:underline cursor-pointer font-bold"
                      >
                        Select
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIVA ACCESS BLOCKED SCREEN IF ANOMALY > 30% */}
      {isVivaBlocked ? (
        <div className="p-6 sm:p-8 rounded-2xl bg-red-950/40 border-2 border-red-500/70 shadow-2xl backdrop-blur-md animate-in fade-in mb-6">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-red-900/60 pb-5 mb-5">
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-2xl bg-red-900 border-2 border-red-400 flex items-center justify-center text-red-100 shrink-0 shadow-lg mt-0.5">
                <Lock className="w-8 h-8 text-red-200 animate-pulse" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <span className="text-xs font-black px-2.5 py-0.5 rounded-full bg-red-600 border border-red-400 text-white uppercase tracking-wider">
                    VIVA ACCESS RESTRICTED
                  </span>
                  <span className="text-xs font-mono font-bold text-red-200 bg-white px-2.5 py-0.5 rounded-full border border-red-500/50">
                    Enterprise Screening Gate (30% Max Anomaly)
                  </span>
                </div>
                <h2 className="text-xl sm:text-2xl font-black text-[#111827] font-sans tracking-wide">
                  Candidate Blocked from Technical Viva
                </h2>
                <p className="text-xs sm:text-sm text-red-200 mt-1 font-sans leading-relaxed">
                  {candidate.viva_block_reason || candidate.viva_blocked_reason || (
                    candidate.is_prompt_injected || candidate.security_scan?.is_prompt_injected
                      ? "Adversarial Prompt Injection Directives were detected in this repository attempting to override evaluation rubrics."
                      : candidate.is_clone
                      ? `Candidate repository exhibits high code overlap (${cloneScore}%) with external tutorial sources, exceeding the 30% threshold.`
                      : `Candidate repository exhibits a ${anomalyScore}% forensic anomaly (Authenticity: ${authenticityScore}%), exceeding the 30% permissible limit.`
                  )}
                </p>
              </div>
            </div>

            <div className="bg-white border border-red-500/50 px-4 py-3 rounded-xl shrink-0 text-right">
              <span className="text-[10px] text-gray-500 uppercase font-bold block">Observed Anomaly</span>
              <span className="text-2xl font-black text-red-600 font-mono">{anomalyScore}%</span>
              <span className="text-[10px] text-red-300 block font-bold">Policy Limit: 30%</span>
            </div>
          </div>

          {/* 3 Metric Diagnosis Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
            <div className="p-3.5 rounded-xl bg-white border border-red-500/30">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">
                Authenticity Score
              </span>
              <span className="text-xl font-bold font-mono text-red-600">
                {authenticityScore}%
              </span>
              <span className="text-[10px] text-gray-500 block mt-0.5">Required: ≥ 70%</span>
            </div>

            <div className="p-3.5 rounded-xl bg-white border border-red-500/30">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">
                Security Threat
              </span>
              <span className="text-xl font-bold font-mono text-[#4b5563]">
                {candidate.is_prompt_injected || candidate.security_scan?.is_prompt_injected ? "CRITICAL" : "NORMAL"}
              </span>
              <span className="text-[10px] text-gray-500 block mt-0.5">Prompt Injection Shield</span>
            </div>

            <div className="p-3.5 rounded-xl bg-white border border-red-500/30">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-1">
                Git Progression
              </span>
              <span className="text-xl font-bold font-mono text-[#111827]">
                {candidate.git_dna?.total_commits || 0} Commits
              </span>
              <span className="text-[10px] text-gray-500 block mt-0.5">Single commit dump flagged</span>
            </div>
          </div>

          {/* Quarantined Vectors or Clone Overlap Display */}
          {candidate.security_scan?.findings && candidate.security_scan.findings.length > 0 && (
            <div className="mb-5 p-4 rounded-xl bg-white border border-red-500/40">
              <span className="text-xs font-bold text-[#4b5563] uppercase tracking-wider block mb-2">
                Violating Vectors Intercepted in Repository:
              </span>
              <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                {candidate.security_scan.findings.slice(0, 4).map((f, i) => (
                  <div key={i} className="text-xs font-mono text-gray-800 flex items-center justify-between bg-red-950/30 p-2 rounded border border-red-900/40">
                    <span className="text-red-600 font-bold">{f.file}:{f.line_number}</span>
                    <span className="text-gray-700 truncate max-w-[280px]">"{f.snippet}"</span>
                    <span className="px-1.5 py-0.5 rounded bg-red-900/60 text-red-200 text-[10px] uppercase font-bold">
                      {f.category}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action to Re-qualify */}
          <div className="p-4 rounded-xl bg-gray-50 border border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <span className="text-xs font-bold text-[#4b5563] uppercase tracking-wider block">
                Enterprise Remediation Guidance:
              </span>
              <p className="text-xs text-gray-600 mt-0.5">
                Remove adversarial instructions, eliminate public tutorial boilerplate, and submit an authentic multi-commit repository to unlock Viva.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => onNavigateToTab('terminal')}
                className="btn-secondary text-xs px-3.5 py-2 font-bold cursor-pointer"
              >
                Inspect Clone Radar
              </button>
              <button
                onClick={() => onNavigateToTab('proofcard')}
                className="btn-primary text-xs px-3.5 py-2 font-bold cursor-pointer"
              >
                View Skill Card
              </button>
            </div>
          </div>
        </div>
      ) : !isVivaActive ? (
        <div className="p-8 sm:p-12 rounded-2xl bg-white border border-gray-200 shadow-sm text-center">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-red-50 border border-red-200 text-[#e20001] text-xs font-bold uppercase tracking-wider mb-4">
            <Zap className="w-4 h-4 text-[#e20001] fill-[#e20001]" />
            <span>10 Technical Viva Questions Prepared</span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-black text-[#111827] tracking-tight mb-2 font-sans">
            Candidate Technical Viva
          </h2>
          <p className="text-sm sm:text-base text-gray-600 max-w-xl mx-auto mb-6 leading-relaxed">
            Ready to assess <strong>{candidate.name}</strong> on 10 verified architecture, system design, and algorithmic implementation questions derived from their source code.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl mx-auto mb-8 text-left">
            <div className="p-4 rounded-xl bg-gray-50 border border-gray-200">
              <div className="text-xs font-bold text-[#111827] uppercase tracking-wider mb-1">10 Questions</div>
              <p className="text-xs text-gray-500">Targeted on real AST code branches & key functions.</p>
            </div>
            <div className="p-4 rounded-xl bg-gray-50 border border-gray-200">
              <div className="text-xs font-bold text-[#111827] uppercase tracking-wider mb-1">Voice & Speech</div>
              <p className="text-xs text-gray-500">Live microphone recognition or manual text response.</p>
            </div>
            <div className="p-4 rounded-xl bg-gray-50 border border-gray-200">
              <div className="text-xs font-bold text-[#111827] uppercase tracking-wider mb-1">Anti-Bias Scoring</div>
              <p className="text-xs text-gray-500">Scored strictly on verified code competence.</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setIsVivaActive(true);
              setIsTimerRunning(true);
              const targetQ = questions[currentQuestionIndex] || questions[0];
              const { seconds } = calculateQuestionTime(targetQ);
              setTimeLeft(seconds || 60);
            }}
            className="btn-primary text-base font-bold shadow-lg hover:shadow-xl transition-all cursor-pointer inline-flex items-center gap-2 px-8 py-3.5"
          >
            <Zap className="w-5 h-5 text-white fill-white" />
            <span>Take Viva</span>
            <ArrowRight className="w-4 h-4 text-white" />
          </button>
          <p className="text-xs text-gray-400 mt-3 font-medium">Click to unlock questions, start timer, and begin oral evaluation.</p>
        </div>
      ) : (
        <>
      {/* Question Selector & Countdown Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-1.5">
          {questions.map((q, idx) => {
            const isEvaluated = evaluatedAnswers[idx] !== undefined;
            const isCurrent = idx === currentQuestionIndex;
            const isLocked = idx > 0 && Array.from({ length: idx }, (_, i) => i).some(prevIdx => evaluatedAnswers[prevIdx] === undefined);
            return (
              <button
                key={q.question_id || idx}
                onClick={() => {
                  if (!isLocked) {
                    setCurrentQuestionIndex(idx);
                  }
                }}
                disabled={isLocked}
                title={isLocked ? `Answer preceding questions first to unlock Question ${idx + 1}` : undefined}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-bold transition border ${
                  isLocked
                    ? 'bg-gray-50 border-gray-200 text-neutral-600 cursor-not-allowed opacity-60'
                    : isCurrent
                    ? 'bg-[#e20001] border-gray-200 text-white shadow-md cursor-pointer'
                    : isEvaluated
                    ? 'bg-white border-emerald-500/60 text-emerald-300 cursor-pointer'
                    : 'bg-white border-gray-200 text-gray-500 hover:text-[#111827] cursor-pointer'
                }`}
              >
                Q{idx + 1} {isLocked ? '🔒' : isEvaluated ? '✓' : ''}
              </button>
            );
          })}
        </div>

        {/* Dynamic Countdown Timer */}
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-mono font-bold ${
            timeLeft <= 10
              ? 'bg-red-950/60 border-red-500 text-red-300 animate-pulse'
              : 'bg-gray-50 border-gray-200 text-[#4b5563]'
          }`}>
            <Clock className="w-3.5 h-3.5" />
            <span>{timeLeft}s REMAINING</span>
          </div>
        </div>
      </div>

      {/* Enterprise AI Prompting Policy & Tolerance Gate (Admin / Company Only) */}
      {portalMode === 'admin' && (
      <div className="p-5 rounded-2xl mb-6 bg-white backdrop-blur-md border border-gray-200 shadow-2xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-200 pb-3">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-5 h-5 text-[#4b5563]" />
            <div>
              <h3 className="text-sm font-bold text-[#111827] font-sans flex items-center gap-2">
                <span>Enterprise AI Prompting Policy & Tolerance Gate</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-50 border border-gray-200 text-[#4b5563]">
                  Active Gate
                </span>
              </h3>
              <p className="text-[11px] text-gray-600">
                Allows AI prompting according to company template, but strictly penalizes code exceeding the AI limit
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-[#4b5563] font-bold">Max AI Limit:</span>
            <span className={`text-sm font-bold font-mono px-2.5 py-0.5 rounded-lg border ${
              toleranceLimit <= 20 
                ? 'bg-blue-950/60 border-blue-500 text-blue-300' 
                : toleranceLimit <= 35 
                  ? 'bg-amber-950/60 border-gray-200 text-amber-300' 
                  : 'bg-purple-950/60 border-purple-500 text-purple-300'
            }`}>
              {toleranceLimit}%
            </span>
          </div>
        </div>

        {/* Template Selector Pills */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {[
            { id: 'strict-core-logic', name: 'Strict Human Core', limit: 20, desc: 'AI for syntax only; logic must be 100% human' },
            { id: 'balanced-copilot', name: 'Balanced Copilot', limit: 35, desc: 'Permits scaffolding/templates up to 35%' },
            { id: 'ai-native-builder', name: 'AI-Native Builder', limit: 50, desc: 'Allows prompt-engineering velocity up to 50%' },
          ].map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => handleTemplateChange(t.id)}
              className={`p-3 rounded-xl border text-left transition cursor-pointer ${
                selectedTemplateId === t.id
                  ? 'bg-red-50 border-[#e20001] shadow-md ring-1 ring-[#E85D04]'
                  : 'bg-gray-50 border-gray-200 hover:border-gray-200 text-gray-500'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-[#111827]">{t.name}</span>
                <span className="text-[10px] font-mono text-[#4b5563]">{t.limit}% Limit</span>
              </div>
              <p className="text-[10px] text-gray-500 line-clamp-1">{t.desc}</p>
            </button>
          ))}
        </div>

        {/* Interactive Limit Slider */}
        <div className="p-3.5 rounded-xl bg-gray-50 border border-gray-200 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-[#4b5563] font-sans">
              Custom Company Threshold Slider:
            </span>
            <span className="font-mono text-[#111827] font-bold">
              {toleranceLimit}% Allowed AI-Assisted Code
            </span>
          </div>
          <input
            type="range"
            min="5"
            max="80"
            step="5"
            value={toleranceLimit}
            onChange={(e) => {
              setToleranceLimit(Number(e.target.value));
              setLiveToleranceResult(null);
            }}
            className="w-full accent-[#E85D04] cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-gray-400 font-mono">
            <span>5% (Zero AI Tolerance)</span>
            <span>35% (Industry Standard)</span>
            <span>80% (Permissive)</span>
          </div>
        </div>

        {/* Policy Rules & Categories */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200">
            <span className="text-[10px] uppercase font-bold text-emerald-700 block mb-1">
              ✓ Allowed Prompting in this Template:
            </span>
            <p className="text-[11px] text-gray-700">
              {(activeTemplate.allowed_categories || []).join(' • ')}
            </p>
          </div>
          <div className="p-2.5 rounded-lg bg-red-50 border border-red-200">
            <span className="text-[10px] uppercase font-bold text-red-600 block mb-1">
              ✕ Flagged if Exceeding Limit:
            </span>
            <p className="text-[11px] text-gray-700">
              {(activeTemplate.prohibited_categories || []).join(' • ')} — Triggers mandatory live viva!
            </p>
          </div>
        </div>
      </div>
      )}

      {/* Main Question Defense Card */}
      <div className="p-6 rounded-2xl bg-white border border-gray-200 shadow-sm">
        {/* Stream Track Switcher Banner */}
        <div className="p-3.5 mb-5 rounded-2xl bg-white border border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${
              isNonTech ? 'bg-purple-100 text-purple-700' : 'bg-red-50 text-[#e20001]'
            }`}>
              {isNonTech ? <Briefcase className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono uppercase font-bold text-gray-500">Active Stream:</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  isNonTech ? 'bg-purple-100 text-purple-800 border border-purple-200' : 'bg-red-50 text-red-800 border border-red-200'
                }`}>
                  {isNonTech ? '💼 Non-Technical Branch (MBA, Strategy & Product)' : '⚡ Technical Branch (Software & ML)'}
                </span>
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {isNonTech
                  ? 'Code snippets waived. Oral defense evaluates ROI attribution, cross-functional trade-offs & crisis diagnostics.'
                  : 'Abstract Syntax Tree and Git-DNA active. Oral defense evaluates function architecture & memory bounds.'}
              </p>
            </div>
          </div>

          {onSelectCandidate && cohort && cohort.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-400 font-mono">Switch candidate:</span>
              <select
                value={candidate.candidate_id}
                onChange={(e) => {
                  const found = cohort.find(c => c.candidate_id === e.target.value);
                  if (found) onSelectCandidate(found);
                }}
                className="text-xs font-sans font-bold bg-gray-50 border border-gray-300 rounded-lg px-2.5 py-1.5 text-gray-800 focus:outline-none cursor-pointer"
              >
                {cohort.map(c => (
                  <option key={c.candidate_id} value={c.candidate_id}>
                    {c.name} ({c.stream_track === 'NON_TECHNICAL' ? 'MBA / Strategy' : 'Tech / Code'})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between text-xs font-mono mb-2">
            <span className="flex items-center gap-1.5">
              {isNonTech ? (
                <>
                  <Briefcase className="w-3.5 h-3.5 text-purple-600" />
                  <span className="text-purple-700 font-bold">
                    Executive Strategy Target: <strong>{currentQ.function_name?.replace(/_/g, ' ').toUpperCase() || 'STRATEGIC DECISION'}</strong> ({candidate.project_name || 'Portfolio / Case Study'})
                  </span>
                </>
              ) : (
                <>
                  <Code className="w-3.5 h-3.5 text-[#4b5563]" />
                  <span className="text-[#4b5563]">
                    Extracted Target: <strong>{currentQ.function_name || 'core_logic'}()</strong> in {currentQ.file || 'repo'}:{currentQ.line_number || 1}
                  </span>
                </>
              )}
            </span>
            <span className={`px-2 py-0.5 rounded uppercase font-bold text-[10px] ${
              currentQ.difficulty === 'hard'
                ? 'bg-red-950 border border-red-600 text-red-300'
                : 'bg-amber-950 border border-gray-200 text-amber-300'
            }`}>
              {currentQ.difficulty}
            </span>
          </div>

          <h2 className="text-base sm:text-lg font-bold text-[#111827] leading-relaxed">
            "{currentQ.question}"
          </h2>
        </div>

        {isNonTech ? (
          /* EXECUTIVE STRATEGIC SCENARIO & BUSINESS BRIEF CARD */
          <div className="mb-5 rounded-2xl bg-gradient-to-br from-purple-50/60 via-white to-gray-50 border border-purple-200 overflow-hidden shadow-sm">
            <div className="bg-purple-100/70 px-4 py-2.5 border-b border-purple-200/70 flex items-center justify-between text-xs font-sans">
              <span className="font-bold uppercase tracking-wider text-purple-900 flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-purple-700" />
                <span>Executive Case Scenario & Strategy Brief</span>
              </span>
              <span className="font-mono text-xs text-purple-800 font-bold px-2 py-0.5 rounded-full bg-purple-200/80">
                {candidate.project_type || 'Product & Strategy'}
              </span>
            </div>

            {/* Scenario Navigation Tabs */}
            <div className="px-4 py-2.5 bg-white border-b border-purple-100 flex flex-wrap items-center gap-2">
              {[
                { title: '1. ROI & Unit Economics', badge: 'Quantitative' },
                { title: '2. Stakeholder Dilemma', badge: 'Leadership' },
                { title: '3. 48-Hour Growth Drop', badge: 'Crisis Triage' }
              ].map((sc, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setCurrentQuestionIndex(i)}
                  className={`px-3 py-1.5 rounded-xl font-sans text-xs transition cursor-pointer flex items-center gap-2 font-medium ${
                    currentQuestionIndex === i
                      ? 'bg-purple-700 text-white shadow-sm font-bold'
                      : 'bg-purple-50 text-purple-900 border border-purple-200 hover:bg-purple-100'
                  }`}
                >
                  <span>{sc.title}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    currentQuestionIndex === i ? 'bg-purple-900 text-purple-200' : 'bg-white text-purple-700 font-bold'
                  }`}>
                    {sc.badge}
                  </span>
                </button>
              ))}
            </div>

            {/* Scenario Details Grid */}
            <div className="p-4 sm:p-5 bg-white space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="p-3.5 rounded-xl bg-purple-50/50 border border-purple-100">
                  <span className="text-[10px] uppercase font-bold text-purple-800 tracking-wider block mb-1">
                    Business Context
                  </span>
                  <p className="text-xs text-gray-800 font-medium leading-relaxed">
                    {currentQuestionIndex === 0 && `Candidate claims quantified impact in '${candidate.project_name || 'Initiative'}'. The executive committee demands verification of financial models, payback horizons, and attribution logic.`}
                    {currentQuestionIndex === 1 && "Engineering needs 2 sprints for architectural debt; Enterprise Sales demands immediate features to hit Q3 quotas with zero headcount expansion."}
                    {currentQuestionIndex === 2 && "Primary self-serve conversion funnel drops 30% MoM over a 48-hour window without any intentional changes to campaigns or ad creative."}
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-amber-50/60 border border-amber-200/70">
                  <span className="text-[10px] uppercase font-bold text-amber-900 tracking-wider block mb-1">
                    Strategic Trade-off / Constraint
                  </span>
                  <p className="text-xs text-gray-800 font-medium leading-relaxed">
                    {currentQuestionIndex === 0 && "Scaling customer acquisition velocity without deteriorating CAC payback or experiencing adverse cohort retention churn."}
                    {currentQuestionIndex === 1 && "Balancing technical stability and team burnout against enterprise ARR revenue commitments under fixed sprint velocity."}
                    {currentQuestionIndex === 2 && "Distinguishing instrumentation/tracking drops from auction saturation or checkout UX drop-offs under CEO urgency."}
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-emerald-50/60 border border-emerald-200/70">
                  <span className="text-[10px] uppercase font-bold text-emerald-900 tracking-wider block mb-1">
                    Target Impact & KPIs
                  </span>
                  <p className="text-xs text-gray-800 font-medium leading-relaxed">
                    {currentQuestionIndex === 0 && "LTV:CAC > 3.0x · Payback < 8 Months · Positive Net Contribution Margin"}
                    {currentQuestionIndex === 1 && "RICE Score Ranking · 70/20/10 Capacity Rule · Zero Unbudgeted ARR Churn"}
                    {currentQuestionIndex === 2 && "Root-Cause Triage < 48 Hrs · Step-Level Funnel Audit · Recovery Hotfix"}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-purple-100 text-xs">
                <span className="text-gray-600 font-medium">
                  Verified Deliverable: <strong className="text-purple-900 font-mono">{candidate.portfolio_url || candidate.repo_url || 'https://hritiksakpal.github.io/portfolio/'}</strong>
                </span>
                <span className="text-purple-800 font-medium">
                  Evaluation Framework: <span className="font-semibold">
                    {currentQuestionIndex === 0 && "Unit Economics & Attribution"}
                    {currentQuestionIndex === 1 && "RICE Prioritization & Alignment"}
                    {currentQuestionIndex === 2 && "MECE Funnel Diagnostics"}
                  </span>
                </span>
              </div>
            </div>
          </div>
        ) : (
          /* TECHNICAL CODE SNIPPET BOX (Existing behavior for technical candidates) */
          <div className="mb-5 rounded-2xl bg-gray-900 border border-gray-200 overflow-hidden shadow-xl">
            <div className="bg-gray-50 px-4 py-2.5 border-b border-gray-200 flex items-center justify-between text-xs font-sans">
              <span className="font-bold uppercase tracking-wider text-[#4b5563] flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[#4b5563]" />
                <span>Key Functions Extracted from Code</span>
              </span>
              <span className="font-mono text-xs text-[#4b5563] font-bold">
                {(complexFunctions.length > 0 ? complexFunctions : candidate?.complex_functions || []).length} Functions Identified
              </span>
            </div>

            {/* Function Tabs */}
            {(complexFunctions.length > 0 ? complexFunctions : candidate?.complex_functions || []).length > 0 && (
              <div className="px-4 py-2 bg-white border-b border-[#2A241B] flex flex-wrap items-center gap-2">
                {(complexFunctions.length > 0 ? complexFunctions : candidate?.complex_functions || []).map((f, i) => {
                  const isSelected = selectedFuncIndex === i;
                  const isCurrentTarget = f.function_name === currentQ.function_name;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setSelectedFuncIndex(i)}
                      className={`px-3 py-1.5 rounded-xl font-mono text-xs transition cursor-pointer flex items-center gap-2 ${
                        isSelected
                          ? 'bg-[#e20001] text-white border border-gray-200 shadow-sm font-bold'
                          : isCurrentTarget
                          ? 'bg-white text-[#4b5563] border border-gray-200 hover:bg-amber-50'
                          : 'bg-gray-50 text-gray-600 border border-gray-200 hover:border-gray-200'
                      }`}
                    >
                      <span>{f.function_name}()</span>
                      <span className="px-1.5 py-0.2 rounded bg-white text-[10px] text-[#4b5563] font-bold">
                        Complexity: {f.complexity}
                      </span>
                      {isCurrentTarget && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#FFD166] animate-pulse"></span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Verified Code Snippet Box */}
            <div className="bg-[#f8fafc] rounded-b-xl overflow-hidden border border-gray-300">
              <div className="px-4 py-2.5 bg-gray-100 border-b border-gray-200 flex items-center justify-between text-xs font-mono text-[#111827] font-bold">
                <span>{activeSnippetFunc.file}:{activeSnippetFunc.line_number}</span>
                <span className="text-[#e20001] font-bold">Verified Code Snippet</span>
              </div>
              <pre className="p-4 text-xs text-[#111827] font-mono font-semibold overflow-x-auto leading-relaxed max-h-64 scrollbar-thin bg-[#f8fafc]">
                <code className="text-[#111827] font-semibold">{activeSnippetFunc.snippet}</code>
              </pre>
            </div>
          </div>
        )}

        {/* Expected Concepts */}
        <div className="mb-4 p-3.5 rounded-xl bg-gray-50 border border-gray-200">
          <span className="text-xs font-bold text-[#4b5563] uppercase tracking-wider block mb-2">
            Key Grading Concepts:
          </span>
          <div className="flex flex-wrap gap-2">
            {(currentQ.expected_concepts || []).map((c, i) => (
              <span key={i} className="text-xs sm:text-sm px-3 py-1 rounded-full bg-gray-100 border border-gray-200 text-[#111827] font-medium">
                {c}
              </span>
            ))}
          </div>
        </div>

        {/* Candidate Answer Box */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs sm:text-sm font-bold uppercase tracking-wider text-[#4b5563]">
              Candidate Answer (Voice or Text)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {/* Voice Answer Microphone Button - Always Available */}
              <button
                type="button"
                onClick={toggleVoiceDefense}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition cursor-pointer border shadow-xs ${
                  isListening
                    ? 'bg-red-600 border-red-600 text-white animate-pulse'
                    : 'bg-red-50 border border-red-200 text-[#e20001] hover:bg-red-100 hover:border-[#e20001]'
                }`}
                title="Click to speak your technical answer via microphone"
              >
                {isListening ? <MicOff className="w-3.5 h-3.5 text-white" /> : <Mic className="w-3.5 h-3.5 text-[#e20001]" />}
                <span>{isListening ? 'Listening (Click to stop)' : 'Voice Answer (Mic)'}</span>
              </button>

              {/* Sample Voice Answer Shortcut */}
              <button
                type="button"
                onClick={handleInsertSampleSpokenAnswer}
                className="hidden sm:inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold transition cursor-pointer border border-gray-200 bg-white text-[#4b5563] hover:text-[#111827] hover:border-gray-400 shadow-xs"
                title="Populate candidate spoken response directly"
              >
                <span>Sample Voice Answer</span>
              </button>

              {/* Retake Question Button if evaluated */}
              {isCurrentEvaluated && (
                <button
                  type="button"
                  onClick={handleRetakeQuestion}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold transition cursor-pointer border border-gray-200 bg-white text-[#111827] hover:border-[#e20001] hover:text-[#e20001] shadow-xs"
                  title="Clear answer and re-attempt this question"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-[#e20001]" />
                  <span>Retake Question</span>
                </button>
              )}

              {!isCurrentEvaluated && (
                <button
                  type="button"
                  onClick={handleAuditAiTolerance}
                  disabled={!userAnswer.trim() || isAuditingTolerance}
                  className="px-3 py-1.5 rounded-lg border text-xs font-mono font-bold transition flex items-center gap-1.5 cursor-pointer bg-purple-50 border-purple-200 text-purple-800 hover:bg-purple-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isAuditingTolerance ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-purple-700" />}
                  <span>Audit vs AI Policy</span>
                </button>
              )}
            </div>
          </div>
          {voiceError && (
            <p className="mb-2 text-xs text-amber-300" role="status">{voiceError}</p>
          )}
          {isListening && interimTranscript && (
            <p className="mb-2 text-xs text-gray-600 italic" aria-live="polite">Hearing: {interimTranscript}</p>
          )}
          <textarea
            rows={3}
            value={userAnswer}
            onChange={e => setUserAnswer(e.target.value)}
            disabled={isCurrentEvaluated || isEvaluating}
            placeholder={isCurrentEvaluated ? "Question already evaluated. Click Retake Question to answer again." : "Type your answer or click Voice Answer (Mic) to speak..."}
            className="w-full bg-white border border-gray-200 focus:border-[#e20001] rounded-xl p-3.5 text-xs sm:text-sm text-[#111827] font-semibold leading-relaxed focus:outline-none font-mono transition"
          ></textarea>
          {timeLeft === 0 && !isCurrentEvaluated && (
            <p className="mt-1.5 text-xs text-red-600 font-mono flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              <span>Time has expired. Answer input is locked and auto-submitted.</span>
            </p>
          )}

          {/* Live AI Policy Tolerance Audit Banner */}
          {liveToleranceResult && (
            <div className={`mt-3 p-3.5 rounded-xl border text-xs transition animate-fadeIn ${
              liveToleranceResult.verdict === 'PASS'
                ? 'bg-emerald-950/50 border-emerald-500/60 text-emerald-200'
                : liveToleranceResult.verdict === 'WARN'
                  ? 'bg-amber-950/50 border-gray-200/60 text-amber-200'
                  : 'bg-red-950/60 border-red-500/80 text-red-100 shadow-[0_0_15px_rgba(239,68,68,0.3)]'
            }`}>
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold flex items-center gap-2">
                  <span>{liveToleranceResult.badge}</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white border border-white/20">
                    Template: {liveToleranceResult.template_name} ({liveToleranceResult.tolerance_percent}% Limit)
                  </span>
                </span>
                <span className="font-mono text-[11px] font-bold">
                  {liveToleranceResult.exceeded ? `Exceeded by +${liveToleranceResult.excess_percent}%` : 'Compliant'}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-gray-800">
                {liveToleranceResult.message}
              </p>
            </div>
          )}
        </div>

        {/* Evaluation Result Banner */}
        {isCurrentEvaluated && (
          <div className={`p-4 rounded-xl border mb-4 text-xs ${
            evaluatedAnswers[currentQuestionIndex].passed
              ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-200'
              : 'bg-red-950/40 border-red-500/60 text-red-200'
          }`}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-sans font-bold flex items-center gap-2 uppercase tracking-wider text-sm">
                {evaluatedAnswers[currentQuestionIndex].passed ? (
                  <CheckCircle className="w-4 h-4 text-emerald-700" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-600" />
                )}
                <span className="text-sm font-bold">Score: {evaluatedAnswers[currentQuestionIndex].score} / 10</span>
              </span>
              <span className={`text-xs uppercase font-bold px-3 py-1 rounded-full border ${
                evaluatedAnswers[currentQuestionIndex].passed
                  ? 'bg-emerald-900/60 border-emerald-400 text-emerald-300'
                  : 'bg-red-900/60 border-red-400 text-red-300'
              }`}>
                {evaluatedAnswers[currentQuestionIndex].passed ? 'PASSED' : 'FAILED (Score: 0)'}
              </span>
            </div>
            <p className="text-[#111827] text-sm leading-relaxed font-sans font-medium">
              {evaluatedAnswers[currentQuestionIndex].feedback}
            </p>

            {/* Prompt Injection Warning if detected */}
            {evaluatedAnswers[currentQuestionIndex].adversarial_injection_detected && (
              <div className="mt-3 p-2.5 rounded-lg bg-amber-950/60 border border-gray-200/60 text-amber-200 text-xs flex items-center gap-2 font-mono">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                <span><strong>Adversarial Injection Neutralized:</strong> Hostile system prompt overrides or HTML comments in candidate response were detected and sanitized.</span>
              </div>
            )}

            {/* AI Text Pattern Detection Analysis */}
            {evaluatedAnswers[currentQuestionIndex].ai_detection && (
              <div className="mt-3 pt-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-gray-500">AI Pattern Detection:</span>
                  {evaluatedAnswers[currentQuestionIndex].ai_detection.classification === 'ai_like' && (
                    <span className="px-2.5 py-0.5 rounded-full bg-red-950/80 border border-red-500 text-red-200 font-bold flex items-center gap-1">
                      <span>🤖 AI-Generated Pattern ({Math.round((evaluatedAnswers[currentQuestionIndex].ai_detection.ai_probability || 0.8) * 100)}% prob) — Score Penalized</span>
                    </span>
                  )}
                  {evaluatedAnswers[currentQuestionIndex].ai_detection.classification === 'human_like' && (
                    <span className="px-2.5 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-500 text-emerald-200 font-bold flex items-center gap-1">
                      <span>👤 Verified Human Authorship ({Math.round((evaluatedAnswers[currentQuestionIndex].ai_detection.human_probability || 0.9) * 100)}% confidence)</span>
                    </span>
                  )}
                  {evaluatedAnswers[currentQuestionIndex].ai_detection.classification === 'mixed_or_uncertain' && (
                    <span className="px-2.5 py-0.5 rounded-full bg-amber-950/80 border border-gray-200 text-amber-200 font-bold flex items-center gap-1">
                      <span>⚖️ Mixed / Uncertain Style</span>
                    </span>
                  )}
                  {evaluatedAnswers[currentQuestionIndex].ai_detection.classification === 'insufficient_text' && (
                    <span className="px-2.5 py-0.5 rounded-full bg-neutral-900 border border-gray-200 text-gray-500 font-bold flex items-center gap-1">
                      <span>ℹ️ Short Answer (AI check skipped)</span>
                    </span>
                  )}
                  {evaluatedAnswers[currentQuestionIndex].ai_detection.classification === 'unsupported_language' && (
                    <span className="px-2.5 py-0.5 rounded-full bg-neutral-900 border border-gray-200 text-gray-500 font-bold flex items-center gap-1">
                      <span>🌐 Non-English Script</span>
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-gray-500 font-mono">Model: {evaluatedAnswers[currentQuestionIndex].ai_detection.model_version}</span>
              </div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-gray-200">
          <span className="text-sm text-gray-800 font-sans">
            Progress: <strong className="text-[#111827]">{Object.keys(evaluatedAnswers).length}</strong> / <strong className="text-[#111827]">{questions.length}</strong> Evaluated
          </span>

          <div className="flex items-center gap-2">
            {!isCurrentEvaluated ? (
              <button
                onClick={handleSubmitAnswer}
                disabled={isEvaluating || !userAnswer.trim()}
                className="btn-primary text-sm flex items-center gap-2 shadow-lg cursor-pointer px-6 py-3 font-bold"
              >
                {isEvaluating ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                <span>Submit & Evaluate Answer</span>
              </button>
            ) : (
              <button
                onClick={handleNext}
                className="btn-primary text-xs flex items-center gap-2 shadow-lg cursor-pointer px-5 py-2.5 font-bold"
              >
                <span>{currentQuestionIndex < questions.length - 1 ? 'Next Question' : 'View Verified Pariksha Card'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
};
