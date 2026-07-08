import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// SVG Icons for Premium UI/UX
const IconTrigger = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />
  </svg>
);

const IconMessage = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" />
  </svg>
);

const IconUndo = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </svg>
);

const IconRedo = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
  </svg>
);

const IconLayout = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </svg>
);

const IconTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);


const IconSave = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

const IconRobot = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '6px', color: '#4f46e5' }}>
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <circle cx="12" cy="5" r="2" />
    <path d="M12 7v4" />
    <line x1="8" y1="16" x2="8" y2="16" strokeWidth="2.5" stroke="currentColor" />
    <line x1="16" y1="16" x2="16" y2="16" strokeWidth="2.5" stroke="currentColor" />
  </svg>
);

const IconRadio = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ color: '#94a3b8', display: 'inline-block', verticalAlign: 'middle' }}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="4" fill="currentColor" />
  </svg>
);

const IconCenter = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="3" />
    <line x1="12" y1="2" x2="12" y2="6" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <line x1="2" y1="12" x2="6" y2="12" />
    <line x1="18" y1="12" x2="22" y2="12" />
  </svg>
);

// Custom Trigger Node
const TriggerNode = ({ data, isConnectable, selected }) => {
  return (
    <div style={{
      borderRadius: '10px',
      background: '#ffffff',
      border: selected ? '2px solid #4f46e5' : '1px solid var(--color-grey-border)',
      boxShadow: selected 
        ? '0 0 0 4px rgba(79, 70, 229, 0.2), 0 10px 25px -5px rgba(79, 70, 229, 0.15)' 
        : '0 4px 12px -2px rgba(15, 23, 42, 0.04), 0 0 0 1px rgba(15, 23, 42, 0.02)',
      fontFamily: 'var(--font-sans)',
      fontSize: '0.78rem',
      minWidth: '200px',
      overflow: 'hidden',
      transition: 'all 0.15s ease',
      textAlign: 'left'
    }}>
      {/* Node Header */}
      <div style={{
        background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
        padding: '0.5rem 0.75rem',
        color: '#ffffff',
        fontWeight: '600',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '0.7rem',
        letterSpacing: '0.04em'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <IconTrigger />
          <span>TRIGGER KEYWORD</span>
        </div>
        {selected && (
          <span style={{
            fontSize: '0.55rem',
            background: 'rgba(255,255,255,0.24)',
            padding: '1px 6px',
            borderRadius: '10px',
            fontWeight: '600'
          }}>Selected</span>
        )}
      </div>

      {/* Node Content */}
      <div style={{ padding: '0.75rem' }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.68rem', textTransform: 'uppercase', fontWeight: 600, marginBottom: '4px', letterSpacing: '0.02em' }}>
          User sends:
        </div>
        <div style={{ 
          color: 'var(--text-primary)', 
          fontWeight: '600', 
          fontSize: '0.8rem',
          background: '#f8fafc',
          padding: '0.45rem 0.6rem',
          borderRadius: '6px',
          border: '1px solid #e2e8f0',
          display: 'inline-block',
          width: '100%',
          boxSizing: 'border-box',
          wordBreak: 'break-all'
        }}>
          {data.keyword ? `"${data.keyword}"` : 'Fallback (default)'}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ 
          background: '#4f46e5', 
          width: '10px', 
          height: '10px', 
          border: '2.5px solid #ffffff',
          boxShadow: '0 2px 4px rgba(79,70,229,0.2)'
        }}
        isConnectable={isConnectable}
      />
    </div>
  );
};

// Custom Message Node
const MessageNode = ({ data, isConnectable, selected }) => {
  return (
    <div style={{
      borderRadius: '10px',
      background: '#ffffff',
      border: selected ? '2px solid #059669' : '1px solid var(--color-grey-border)',
      boxShadow: selected 
        ? '0 0 0 4px rgba(16, 185, 129, 0.2), 0 10px 25px -5px rgba(16, 185, 129, 0.15)' 
        : '0 4px 12px -2px rgba(15, 23, 42, 0.04), 0 0 0 1px rgba(15, 23, 42, 0.02)',
      fontFamily: 'var(--font-sans)',
      fontSize: '0.78rem',
      minWidth: '220px',
      overflow: 'hidden',
      transition: 'all 0.15s ease',
      textAlign: 'left'
    }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{ 
          background: '#059669', 
          width: '10px', 
          height: '10px', 
          border: '2.5px solid #ffffff',
          boxShadow: '0 2px 4px rgba(5,150,105,0.2)'
        }}
        isConnectable={isConnectable}
      />
      
      {/* Node Header */}
      <div style={{
        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        padding: '0.5rem 0.75rem',
        color: '#ffffff',
        fontWeight: '600',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '0.7rem',
        letterSpacing: '0.04em'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <IconMessage />
          <span>WHATSAPP REPLY</span>
        </div>
        {selected && (
          <span style={{
            fontSize: '0.55rem',
            background: 'rgba(255,255,255,0.24)',
            padding: '1px 6px',
            borderRadius: '10px',
            fontWeight: '600'
          }}>Selected</span>
        )}
      </div>

      {/* Node Content */}
      <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.68rem', textTransform: 'uppercase', fontWeight: 600, marginBottom: '4px', letterSpacing: '0.02em' }}>
            Response Message:
          </div>
          <div style={{
            color: 'var(--text-primary)',
            fontSize: '0.78rem',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '6px',
            padding: '0.5rem 0.6rem',
            maxHeight: '75px',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            lineHeight: '1.4'
          }}>
            {data.text || <em style={{ color: 'var(--text-muted)' }}>(empty message)</em>}
          </div>
        </div>

        {(data.mediaUrl || data.media_url) && (
          <div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.68rem', textTransform: 'uppercase', fontWeight: 600, marginBottom: '4px', letterSpacing: '0.02em' }}>
              Media Attachment:
            </div>
            <div style={{
              fontSize: '0.7rem',
              background: '#f1f5f9',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              padding: '0.35rem 0.5rem',
              color: '#0f172a',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              whiteSpace: 'nowrap'
            }}>
              <span>📎</span>
              <span title={data.mediaUrl || data.media_url}>
                {(data.mediaUrl || data.media_url).split('/').pop().split('?')[0] || 'Attachment'}
              </span>
            </div>
          </div>
        )}

        {data.buttons && data.buttons.length > 0 && (
          <div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.68rem', textTransform: 'uppercase', fontWeight: 600, marginBottom: '4px', letterSpacing: '0.02em' }}>
              Interactive Buttons:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {data.buttons.map((btn, i) => (
                <div key={i} style={{
                  fontSize: '0.7rem',
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  padding: '0.3rem 0.6rem',
                  color: 'var(--text-primary)',
                  fontWeight: '600',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.02)'
                }}>
                  <IconRadio />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{btn}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Initial nodes and edges templates
const initialNodes = [
  {
    id: 'trigger-1',
    type: 'trigger',
    position: { x: 100, y: 150 },
    data: { keyword: 'interested' }
  },
  {
    id: 'msg-1',
    type: 'message',
    position: { x: 380, y: 130 },
    data: { 
      text: 'Thanks for your interest! Would you like details or to call a counselor?',
      buttons: ['View Details', 'Schedule Call']
    }
  }
];
const initialEdges = [
  { id: 'e-1', source: 'trigger-1', target: 'msg-1' }
];

// Helper to filter out React Flow transient states and round coordinates
const getCleanComparisonString = (nds, eds) => {
  if (!nds) return '';
  const cleanNodes = nds.map(n => ({
    id: n.id,
    type: n.type,
    x: Math.round(n.position?.x || 0),
    y: Math.round(n.position?.y || 0),
    data: n.data
  }));
  const cleanEdges = (eds || []).map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle
  }));
  return JSON.stringify({ nodes: cleanNodes, edges: cleanEdges });
};

// Parse plain-text flow script into React Flow nodes and edges
const parseScriptToFlow = (text) => {
  const lines = text.split('\n');
  const nodes = [];
  const edges = [];
  
  let currentNode = null;
  let triggerCount = 1;
  
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    
    // Trigger definition: e.g., Trigger: keyword -> [node_id]
    const triggerMatch = line.match(/^Trigger:\s*(.*?)\s*->\s*\[(.*?)\]$/i);
    if (triggerMatch) {
      const keyword = triggerMatch[1].trim();
      const targetId = triggerMatch[2].trim();
      const triggerId = `trigger-${triggerCount++}`;
      
      nodes.push({
        id: triggerId,
        type: 'trigger',
        position: { x: 100, y: 100 },
        data: { keyword }
      });
      
      edges.push({
        id: `e-${triggerId}-${targetId}`,
        source: triggerId,
        target: targetId
      });
      continue;
    }
    
    // Message node header: e.g., [node_id]
    const nodeHeaderMatch = line.match(/^\[(.*?)\]$/);
    if (nodeHeaderMatch) {
      const nodeId = nodeHeaderMatch[1].trim();
      currentNode = {
        id: nodeId,
        type: 'message',
        position: { x: 300, y: 100 },
        data: { text: '', buttons: [] }
      };
      nodes.push(currentNode);
      continue;
    }
    
    // Message text: e.g., Bot: Hello world
    if (line.match(/^Bot:\s*/i) && currentNode) {
      const textVal = line.replace(/^Bot:\s*/i, '').trim();
      currentNode.data.text = textVal;
      continue;
    }
    
    // Button option: e.g., - Button Label -> [node_id]
    const buttonMatch = line.match(/^-\s*(.*?)\s*->\s*\[(.*?)\]$/);
    if (buttonMatch && currentNode) {
      const buttonLabel = buttonMatch[1].trim();
      const targetId = buttonMatch[2].trim();
      
      currentNode.data.buttons.push(buttonLabel);
      
      edges.push({
        id: `e-${currentNode.id}-${targetId}-${Math.random().toString(36).substring(2, 6)}`,
        source: currentNode.id,
        target: targetId
      });
    }
  }
  
  // Auto-generate placeholder nodes for target IDs that are referenced but not defined
  const definedIds = new Set(nodes.map(n => n.id));
  edges.forEach(e => {
    if (!definedIds.has(e.target)) {
      nodes.push({
        id: e.target,
        type: 'message',
        position: { x: 300, y: 100 },
        data: { text: 'New Reply (configure me)', buttons: [] }
      });
      definedIds.add(e.target);
    }
  });
  
  return { nodes, edges };
};

// Generate plain-text flow script from React Flow nodes and edges
const generateScriptFromFlow = (nodes, edges) => {
  let script = "";
  
  // Triggers first
  const triggers = nodes.filter(n => n.type === 'trigger');
  if (triggers.length > 0) {
    script += "// --- Trigger Keywords ---\n";
    triggers.forEach(t => {
      const edge = edges.find(e => e.source === t.id);
      const target = edge ? edge.target : "unknown";
      script += `Trigger: ${t.data.keyword || 'default'} -> [${target}]\n`;
    });
    script += "\n";
  }
  
  // Message replies
  const messages = nodes.filter(n => n.type === 'message');
  if (messages.length > 0) {
    script += "// --- Bot Responses ---\n";
    messages.forEach(m => {
      script += `[${m.id}]\n`;
      script += `Bot: ${m.data.text || ''}\n`;
      
      const outgoingEdges = edges.filter(e => e.source === m.id);
      const btns = m.data.buttons || [];
      
      btns.forEach((btn, idx) => {
        const edge = outgoingEdges[idx];
        const target = edge ? edge.target : "unknown";
        script += `- ${btn} -> [${target}]\n`;
      });
      script += "\n";
    });
  }
  
  return script.trim();
};

// Compute sequence-based auto layout coordinates
const computeAutoLayout = (nodesList) => {
  const triggers = nodesList.filter(n => n.type === 'trigger');
  const messages = nodesList.filter(n => n.type === 'message');
  
  let triggerY = 50;
  const triggerX = 80;
  const updatedTriggers = triggers.map(n => {
    const nodeWithPos = { ...n, position: { x: triggerX, y: triggerY } };
    triggerY += 140;
    return nodeWithPos;
  });

  let messageY = 50;
  const messageX = 420;
  const updatedMessages = messages.map(n => {
    const nodeWithPos = { ...n, position: { x: messageX, y: messageY } };
    messageY += 190;
    return nodeWithPos;
  });

  return [...updatedTriggers, ...updatedMessages];
};

export default function FlowBuilder({ authFetch, API_BASE, activeView, templatesList = [] }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  
  // Node fields
  const [keyword, setKeyword] = useState('');
  const [messageText, setMessageText] = useState('');
  const [buttons, setButtons] = useState([]);
  const [mediaUrl, setMediaUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  
  // Auto-save toggle & manual change tracking
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const isFirstLoadRef = useRef(true);
  const comparisonRef = useRef('');

  // Flow manager states
  const [flowsList, setFlowsList] = useState([]);
  const [currentFlow, setCurrentFlow] = useState(null);
  
  // History states
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const dragStateRef = useRef(null);

  // React Flow Viewport and Auto-Center States
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const [loadCounter, setLoadCounter] = useState(0);
  const [isReady, setIsReady] = useState(false);

  // Script Editor Panel States
  const [activeSidebarTab, setActiveSidebarTab] = useState('config'); // 'config' or 'script'
  const [scriptText, setScriptText] = useState('');

  // Custom Modal state & helper functions
  const [modalConfig, setModalConfig] = useState({
    isOpen: false,
    type: 'confirm', // 'alert', 'confirm', 'prompt'
    title: '',
    message: '',
    inputValue: '',
    isDestructive: false,
    onConfirm: null,
    onCancel: null
  });

  const showCustomModal = useCallback((type, title, message, defaultInput = '', isDestructive = false) => {
    return new Promise((resolve) => {
      setModalConfig({
        isOpen: true,
        type,
        title,
        message,
        inputValue: defaultInput,
        isDestructive,
        onConfirm: (val) => {
          setModalConfig(prev => ({ ...prev, isOpen: false }));
          resolve(type === 'prompt' ? val : true);
        },
        onCancel: () => {
          setModalConfig(prev => ({ ...prev, isOpen: false }));
          resolve(type === 'prompt' ? null : false);
        }
      });
    });
  }, []);

  const showAlert = useCallback((title, message) => showCustomModal('alert', title, message), [showCustomModal]);
  const showConfirm = useCallback((title, message, isDestructive = false) => showCustomModal('confirm', title, message, '', isDestructive), [showCustomModal]);
  const showPrompt = useCallback((title, message, defaultInput = '') => showCustomModal('prompt', title, message, defaultInput), [showCustomModal]);

  // Helper to push state
  const pushToHistory = useCallback((currentNodes, currentEdges) => {
    const clonedNodes = JSON.parse(JSON.stringify(currentNodes));
    const clonedEdges = JSON.parse(JSON.stringify(currentEdges));
    setPast((prev) => [...prev, { nodes: clonedNodes, edges: clonedEdges }]);
    setFuture([]);
  }, []);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    const newPast = past.slice(0, past.length - 1);
    const current = { 
      nodes: JSON.parse(JSON.stringify(nodes)), 
      edges: JSON.parse(JSON.stringify(edges)) 
    };
    setPast(newPast);
    setFuture((prev) => [...prev, current]);
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setSelectedNode(null);
  }, [past, nodes, edges, setNodes, setEdges]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[future.length - 1];
    const newFuture = future.slice(0, future.length - 1);
    const current = { 
      nodes: JSON.parse(JSON.stringify(nodes)), 
      edges: JSON.parse(JSON.stringify(edges)) 
    };
    setPast((prev) => [...prev, current]);
    setFuture(newFuture);
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNode(null);
  }, [future, nodes, edges, setNodes, setEdges]);

  const onNodeDragStart = useCallback(() => {
    dragStateRef.current = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges))
    };
  }, [nodes, edges]);

  const onNodeDragStop = useCallback(() => {
    if (dragStateRef.current) {
      setPast((prev) => [...prev, dragStateRef.current]);
      setFuture([]);
      dragStateRef.current = null;
    }
  }, []);

  const cloneSelectedNode = useCallback(() => {
    if (!selectedNode) return;
    pushToHistory(nodes, edges);
    const id = `${selectedNode.type}-clone-${Date.now()}`;
    const newNode = {
      ...JSON.parse(JSON.stringify(selectedNode)),
      id,
      position: { 
        x: selectedNode.position.x + 40, 
        y: selectedNode.position.y + 40 
      }
    };
    setNodes((nds) => nds.concat(newNode));
    setSelectedNode(newNode);
  }, [selectedNode, nodes, edges, pushToHistory, setNodes]);

  const autoLayout = useCallback(() => {
    pushToHistory(nodes, edges);
    const triggers = nodes.filter(n => n.type === 'trigger');
    const messages = nodes.filter(n => n.type === 'message');
    
    let triggerY = 50;
    const triggerX = 80;
    const updatedTriggers = triggers.map(n => {
      const nodeWithPos = { ...n, position: { x: triggerX, y: triggerY } };
      triggerY += 140;
      return nodeWithPos;
    });

    let messageY = 50;
    const messageX = 420;
    const updatedMessages = messages.map(n => {
      const nodeWithPos = { ...n, position: { x: messageX, y: messageY } };
      messageY += 180;
      return nodeWithPos;
    });

    setNodes([...updatedTriggers, ...updatedMessages]);
    setSelectedNode(null);
  }, [nodes, edges, pushToHistory, setNodes]);

  const clearCanvas = useCallback(async () => {
    const confirmed = await showConfirm(
      "Clear Canvas",
      "Are you sure you want to clear the entire canvas? This cannot be undone unless you click Undo.",
      true // isDestructive
    );
    if (confirmed) {
      pushToHistory(nodes, edges);
      setNodes([]);
      setEdges([]);
      setSelectedNode(null);
    }
  }, [nodes, edges, pushToHistory, setNodes, setEdges, showConfirm]);

  // Define custom node types
  const nodeTypes = useMemo(() => ({
    trigger: TriggerNode,
    message: MessageNode
  }), []);

  // Fetch saved BotFlows from backend and load active or target flow
  const fetchFlows = useCallback(async (selectFlowId = null) => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/bot/flows`);
      if (res && res.ok) {
        const data = await res.json();
        setFlowsList(data);
        if (data && data.length > 0) {
          let flowToLoad = null;
          if (selectFlowId) {
            flowToLoad = data.find(f => f.id === selectFlowId);
          }
          if (!flowToLoad) {
            // Prefer the active flow, fallback to the first (most recent) flow
            flowToLoad = data.find(f => f.is_active) || data[0];
          }
          
          setCurrentFlow(flowToLoad);
          const fNodes = flowToLoad.flow_data?.nodes || [];
          const fEdges = flowToLoad.flow_data?.edges || [];
          setNodes(fNodes);
          setEdges(fEdges);
          comparisonRef.current = getCleanComparisonString(fNodes, fEdges);
          setHasUnsavedChanges(false);
          setLoadCounter(prev => prev + 1);
          setScriptText(generateScriptFromFlow(fNodes, fEdges));
        } else {
          // Initialize default setup if database is completely empty
          const defaultFlowObj = {
            id: null,
            name: 'Default Flow',
            flow_data: { nodes: initialNodes, edges: initialEdges },
            is_active: true
          };
          setCurrentFlow(defaultFlowObj);
          setNodes(initialNodes);
          setEdges(initialEdges);
          comparisonRef.current = getCleanComparisonString(initialNodes, initialEdges);
          setHasUnsavedChanges(false);
          setLoadCounter(prev => prev + 1);
          setScriptText(generateScriptFromFlow(initialNodes, initialEdges));
        }
      }
    } catch (e) {
      console.error("Failed to load bot flows:", e);
    } finally {
      setLoading(false);
    }
  }, [authFetch, API_BASE, setNodes, setEdges]);

  useEffect(() => {
    fetchFlows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsReady(true);
    }, 450);
    return () => clearTimeout(timer);
  }, []);

  // Detect semantic modifications (ignores React Flow transient states)
  useEffect(() => {
    if (loading || !currentFlow) return;
    const currentStr = getCleanComparisonString(nodes, edges);
    if (comparisonRef.current && currentStr !== comparisonRef.current) {
      setHasUnsavedChanges(true);
    } else {
      setHasUnsavedChanges(false);
    }
  }, [nodes, edges, loading, currentFlow]);

  // Auto-center viewport when a new workflow finishes loading/rendering
  useEffect(() => {
    if (reactFlowInstance && loadCounter > 0) {
      const timer = setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2, duration: 400 });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [loadCounter, reactFlowInstance]);

  // Fit view when tab becomes active and flow instance is available
  useEffect(() => {
    if (activeView === 'bot-builder' && reactFlowInstance) {
      const timer = setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2, duration: 400 });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [activeView, reactFlowInstance]);

  const centerView = useCallback(() => {
    if (reactFlowInstance) {
      reactFlowInstance.fitView({ padding: 0.2, duration: 400 });
    }
  }, [reactFlowInstance]);

  // Auto-Save Effect (Debounced to 1.5s after last modification)
  useEffect(() => {
    if (loading || nodes.length === 0 || !autoSaveEnabled || !currentFlow) return;

    const autoSaveTimeout = setTimeout(async () => {
      setSaving(true);
      setStatusMessage('Auto-saving flow changes... 🔄');
      try {
        const payload = {
          id: currentFlow.id,
          name: currentFlow.name || 'Default Flow',
          flow_data: { nodes, edges },
          is_active: currentFlow.is_active !== undefined ? currentFlow.is_active : false,
          template_name: currentFlow.template_name || null
        };
        const res = await authFetch(`${API_BASE}/api/v1/bot/flows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res && res.ok) {
          const result = await res.json();
          setStatusMessage('Workflow auto-saved! ✅');
          setHasUnsavedChanges(false);
          comparisonRef.current = getCleanComparisonString(nodes, edges);
          
          // If this was a new flow (id was null), update its ID so we don't keep recreating it
          if (currentFlow.id === null && result.flow) {
            setCurrentFlow(result.flow);
            // Refresh list in background
            const listRes = await authFetch(`${API_BASE}/api/v1/bot/flows`);
            if (listRes && listRes.ok) {
              const listData = await listRes.json();
              setFlowsList(listData);
            }
          }
        } else {
          setStatusMessage('Auto-save failed.');
        }
      } catch (e) {
        console.error("Auto-save error:", e);
        setStatusMessage('Auto-save error.');
      } finally {
        setSaving(false);
        setTimeout(() => setStatusMessage(''), 2000);
      }
    }, 1500);

    return () => clearTimeout(autoSaveTimeout);
  }, [nodes, edges, loading, autoSaveEnabled, currentFlow, authFetch, API_BASE]);

  // Connect edge handler
  const onConnect = useCallback((connection) => {
    pushToHistory(nodes, edges);
    setEdges((eds) => addEdge(connection, eds));
  }, [nodes, edges, pushToHistory, setEdges]);

  // Node click handler
  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node);
    setActiveSidebarTab('config'); // Automatically open Node Config tab
    if (node.type === 'trigger') {
      setKeyword(node.data.keyword || '');
    } else if (node.type === 'message') {
      setMessageText(node.data.text || '');
      setButtons(node.data.buttons || []);
      setMediaUrl(node.data.mediaUrl || node.data.media_url || '');
    }
  }, []);

  const handleAttachmentUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setUploading(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/media/upload`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Upload failed');
      
      setMediaUrl(data.media_url);
      setStatusMessage('File uploaded successfully! Click Update Node to save.');
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) {
      showAlert('Upload Error', err.message || 'Failed to upload file.');
    } finally {
      setUploading(false);
    }
  };

  // Node editing state updates
  const updateSelectedNode = () => {
    if (!selectedNode) return;
    pushToHistory(nodes, edges);
    
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === selectedNode.id) {
          if (node.type === 'trigger') {
            return {
              ...node,
              data: { ...node.data, keyword }
            };
          } else if (node.type === 'message') {
            // Filter out empty buttons
            const activeBtns = buttons.filter(b => b.trim() !== '');
            return {
              ...node,
              data: { ...node.data, text: messageText, buttons: activeBtns, mediaUrl: mediaUrl }
            };
          }
        }
        return node;
      })
    );
    setStatusMessage('Node configuration updated in builder! Save changes to apply.');
    setTimeout(() => setStatusMessage(''), 3000);
  };

  // Add trigger node
  const addTriggerNode = () => {
    pushToHistory(nodes, edges);
    const id = `trigger-${Date.now()}`;
    const newNode = {
      id,
      type: 'trigger',
      position: { x: 100, y: 100 + nodes.length * 30 },
      data: { keyword: 'keyword' }
    };
    setNodes((nds) => nds.concat(newNode));
  };

  // Add message node
  const addMessageNode = () => {
    pushToHistory(nodes, edges);
    const id = `message-${Date.now()}`;
    const newNode = {
      id,
      type: 'message',
      position: { x: 300, y: 100 + nodes.length * 30 },
      data: { text: 'Bot Response text', buttons: [] }
    };
    setNodes((nds) => nds.concat(newNode));
  };

  // Delete selected node
  const deleteSelectedNode = () => {
    if (!selectedNode) return;
    pushToHistory(nodes, edges);
    setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id));
    setSelectedNode(null);
  };

  // Save layout to backend
  const saveFlowConfig = async (overridePayload = {}) => {
    if (!currentFlow) return;
    setSaving(true);
    setStatusMessage('');
    try {
      const payload = {
        id: currentFlow.id,
        name: currentFlow.name || 'Default Flow',
        flow_data: { nodes, edges },
        is_active: currentFlow.is_active !== undefined ? currentFlow.is_active : false,
        template_name: currentFlow.template_name || null,
        ...overridePayload
      };
      
      const res = await authFetch(`${API_BASE}/api/v1/bot/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (res && res.ok) {
        const result = await res.json();
        if (result.status === 'success') {
          setStatusMessage(payload.is_active ? 'Bot workflow saved and published successfully! 🚀' : 'Bot workflow saved successfully! ✅');
          setHasUnsavedChanges(false);
          comparisonRef.current = getCleanComparisonString(nodes, edges);
          
          // Refresh list to update selectors/active indicators
          const listRes = await authFetch(`${API_BASE}/api/v1/bot/flows`);
          if (listRes && listRes.ok) {
            const listData = await listRes.json();
            setFlowsList(listData);
            const updatedFlow = listData.find(f => f.id === result.flow.id);
            if (updatedFlow) {
              setCurrentFlow(updatedFlow);
            }
          }
        } else {
          setStatusMessage('Failed to save bot workflow. Please check details.');
        }
      } else {
        setStatusMessage('Failed to save bot workflow. Please check details.');
      }
    } catch (e) {
      console.error(e);
      setStatusMessage('Error connecting to backend server.');
    } finally {
      setSaving(false);
      setTimeout(() => setStatusMessage(''), 4000);
    }
  };

  const handleCreateNewFlow = async () => {
    if (hasUnsavedChanges) {
      if (autoSaveEnabled) {
        setStatusMessage('Saving current flow changes before creating new flow... 🔄');
        await saveFlowConfig();
      } else {
        const confirmed = await showConfirm(
          "Discard Unsaved Changes",
          "You have unsaved changes in the current flow. Are you sure you want to discard them and create a new flow?",
          true
        );
        if (!confirmed) return;
      }
    }
    const name = await showPrompt(
      "Create New Workflow",
      "Enter a name for the new workflow:",
      `Flow - ${new Date().toLocaleDateString()}`
    );
    if (!name || name.trim() === '') return;
    
    // Check if name already exists in list
    if (flowsList.some(f => f.name.toLowerCase() === name.trim().toLowerCase())) {
      await showAlert("Duplicate Workflow Name", "A workflow with that name already exists. Please choose a unique name.");
      return;
    }
    
    const newFlowObj = {
      id: null,
      name: name.trim(),
      flow_data: {
        nodes: [
          {
            id: 'trigger-1',
            type: 'trigger',
            position: { x: 100, y: 150 },
            data: { keyword: 'keyword' }
          }
        ],
        edges: []
      },
      is_active: false,
      template_name: null
    };
    
    setCurrentFlow(newFlowObj);
    setNodes(newFlowObj.flow_data.nodes);
    setEdges(newFlowObj.flow_data.edges);
    setPast([]);
    setFuture([]);
    setSelectedNode(null);
    comparisonRef.current = getCleanComparisonString(newFlowObj.flow_data.nodes, []);
    setHasUnsavedChanges(true); // Since it's not saved to database yet
    setLoadCounter(prev => prev + 1);
    setScriptText(generateScriptFromFlow(newFlowObj.flow_data.nodes, []));
  };

  const handleDeleteFlow = async () => {
    if (!currentFlow) return;
    if (currentFlow.id === null) {
      const confirmed = await showConfirm("Discard Draft", "Discard this unsaved draft flow?", true);
      if (confirmed) {
        await fetchFlows();
      }
      return;
    }
    
    if (currentFlow.is_active) {
      await showAlert("Delete Not Allowed", "Cannot delete the active workflow. Please publish another flow first to make this one inactive.");
      return;
    }
    
    const confirmed = await showConfirm(
      "Delete Workflow",
      `Are you sure you want to permanently delete the workflow "${currentFlow.name}"? This cannot be undone.`,
      true
    );
    if (confirmed) {
      setSaving(true);
      setStatusMessage('Deleting workflow... 🗑️');
      try {
        const res = await authFetch(`${API_BASE}/api/v1/bot/flows/${currentFlow.id}`, {
          method: 'DELETE'
        });
        if (res && res.ok) {
          setStatusMessage('Workflow deleted successfully! 🗑️');
          await fetchFlows();
        } else {
          setStatusMessage('Failed to delete workflow.');
        }
      } catch (e) {
        console.error(e);
        setStatusMessage('Error connecting to backend server.');
      } finally {
        setSaving(false);
        setTimeout(() => setStatusMessage(''), 3000);
      }
    }
  };


  const handleToggleFlowActive = async (flow, isActive) => {
    if (!flow) return;
    setSaving(true);
    setStatusMessage(isActive ? 'Activating flow... 🚀' : 'Deactivating flow... ⏸️');
    try {
      const payload = {
        id: flow.id,
        name: flow.name,
        flow_data: flow.flow_data,
        template_name: flow.template_name,
        is_active: isActive
      };
      const res = await authFetch(`${API_BASE}/api/v1/bot/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res && res.ok) {
        await res.json();
        setStatusMessage(isActive ? 'Flow activated successfully! 🚀' : 'Flow deactivated successfully! ⏸️');
        await fetchFlows(currentFlow?.id || flow.id);
      } else {
        setStatusMessage('Failed to update flow active status.');
      }
    } catch (e) {
      console.error(e);
      setStatusMessage('Error connecting to server.');
    } finally {
      setSaving(false);
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const handleAssignFlowToTemplate = async (flow, templateName, isActive) => {
    if (!flow) return;
    setSaving(true);
    setStatusMessage(`Assigning "${flow.name}"... 🔄`);
    try {
      const payload = {
        id: flow.id,
        name: flow.name,
        flow_data: flow.flow_data,
        template_name: templateName || null,
        is_active: isActive
      };
      const res = await authFetch(`${API_BASE}/api/v1/bot/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res && res.ok) {
        await res.json();
        setStatusMessage(`Successfully assigned & activated "${flow.name}"! 🚀`);
        await fetchFlows(currentFlow?.id || flow.id);
      } else {
        setStatusMessage('Failed to assign flow template.');
      }
    } catch (e) {
      console.error(e);
      setStatusMessage('Error connecting to server.');
    } finally {
      setSaving(false);
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const handleLoadFlowIntoCanvas = async (flow) => {
    if (!flow) return;
    if (hasUnsavedChanges) {
      if (autoSaveEnabled) {
        setStatusMessage('Saving current flow changes before switching... 🔄');
        await saveFlowConfig();
      } else {
        const confirmed = await showConfirm(
          "Discard Unsaved Changes",
          "You have unsaved changes. Are you sure you want to switch workflows?",
          true
        );
        if (!confirmed) return;
      }
    }
    setCurrentFlow(flow);
    setNodes(flow.flow_data?.nodes || []);
    setEdges(flow.flow_data?.edges || []);
    comparisonRef.current = getCleanComparisonString(flow.flow_data?.nodes || [], flow.flow_data?.edges || []);
    setHasUnsavedChanges(false);
    setPast([]);
    setFuture([]);
    setSelectedNode(null);
    setLoadCounter(prev => prev + 1);
    setScriptText(generateScriptFromFlow(flow.flow_data?.nodes || [], flow.flow_data?.edges || []));
    setActiveSidebarTab('config'); // Switch to config panel
  };

  const handleButtonChange = (index, val) => {
    const newBtns = [...buttons];
    newBtns[index] = val;
    setButtons(newBtns);
  };

  const customStyles = `
    .premium-node-builder .react-flow__handle {
      width: 10px !important;
      height: 10px !important;
      border: 2px solid #ffffff !important;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1) !important;
    }
    .premium-node-builder .react-flow__handle:hover {
      transform: scale(1.25);
    }
    
    /* Custom Dropdown Selector */
    .custom-select {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 0.4rem 1.75rem 0.4rem 0.75rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: #334155;
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.5rem center;
      background-size: 0.85rem;
      transition: all 0.15s;
    }
    .custom-select:hover {
      background-color: #e2e8f0;
      border-color: #94a3b8;
    }
    .custom-select:focus {
      outline: none;
      border-color: #4f46e5;
      box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.1);
    }

    /* Editable Title Input */
    .borderless-title {
      border: 1px solid #cbd5e1;
      background-color: #ffffff;
      font-size: 0.85rem;
      font-weight: 600;
      padding: 0.4rem 0.75rem;
      border-radius: 8px;
      color: #0f172a;
      transition: all 0.15s;
      outline: none;
      width: 180px;
    }
    .borderless-title:hover {
      border-color: #94a3b8;
      background-color: #f8fafc;
    }
    .borderless-title:focus {
      border-color: #4f46e5;
      background-color: #ffffff;
      box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.15);
    }

    /* Floating Creation Toolbar */
    .canvas-toolbar {
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(255, 255, 255, 0.8);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(226, 232, 240, 0.8);
      border-radius: 999px;
      padding: 6px 18px;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.03);
      z-index: 5;
    }
    .toolbar-divider {
      width: 1px;
      height: 16px;
      background-color: #e2e8f0;
      margin: 0 8px;
    }

    /* Floating History Buttons */
    .canvas-history {
      position: absolute;
      top: 16px;
      left: 16px;
      background: rgba(255, 255, 255, 0.8);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(226, 232, 240, 0.8);
      border-radius: 8px;
      padding: 4px;
      display: flex;
      gap: 2px;
      box-shadow: 0 4px 15px -3px rgba(15, 23, 42, 0.05);
      z-index: 5;
    }

    /* General Premium Buttons */
    .premium-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.35rem;
      font-weight: 500;
      border-radius: 6px;
      padding: 0.4rem 0.75rem;
      font-size: 0.8rem;
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #334155;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: var(--font-sans);
    }
    .premium-btn:hover:not(:disabled) {
      background: #f8fafc;
      border-color: #94a3b8;
      color: #0f172a;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    .premium-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .premium-btn-primary {
      background: linear-gradient(135deg, #4f46e5 0%, #3730a3 100%);
      color: #ffffff;
      border: none;
      font-weight: 600;
      box-shadow: 0 2px 6px rgba(79, 70, 229, 0.25);
    }
    .premium-btn-primary:hover:not(:disabled) {
      background: linear-gradient(135deg, #4338ca 0%, #2e2882 100%);
      color: #ffffff;
      box-shadow: 0 4px 12px rgba(79, 70, 229, 0.35);
    }
    .premium-btn-danger {
      background: #fff1f2;
      color: #df1c1c;
      border: 1px solid #fecdd3;
    }
    .premium-btn-danger:hover:not(:disabled) {
      background: #ffe4e6;
      border-color: #fda4af;
      color: #b91c1c;
    }
    .premium-input {
      width: 100%;
      padding: 0.4rem 0.6rem;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-size: 0.8rem;
      font-family: var(--font-sans);
      color: #1e293b;
      background-color: #ffffff;
      transition: all 0.15s ease;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.02);
    }
    .premium-input:focus {
      outline: none;
      border-color: #4f46e5;
      box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.15);
    }
    .premium-input-emerald:focus {
      border-color: #10b981;
      box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.15);
    }
    .premium-textarea {
      resize: none;
      min-height: 80px;
    }
    .premium-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
    }
    .spinner-inline {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 0.8s linear infinite;
      display: inline-block;
      margin-right: 4px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 4px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    .pulse-dot {
      animation: pulse 2s infinite;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-2px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Responsive styles for FlowBuilder layout */
    .flow-builder-container {
      display: flex;
      width: 100%;
      height: calc(100vh - 120px);
      gap: 1rem;
      padding: 1rem;
    }
    .flow-canvas-wrapper {
      flex-grow: 1;
      position: relative;
      border-radius: var(--radius-lg);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
    }
    .flow-config-panel {
      width: 360px;
      border-radius: var(--radius-lg);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid #e2e8f0;
      background: #ffffff;
    }

    /* Header Bar layout for FlowBuilder */
    .flow-header-bar {
      padding: 0.75rem 1.5rem;
      border-bottom: 1px solid #cbd5e1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #ffffff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
      z-index: 10;
      gap: 1rem;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .flow-header-bar::-webkit-scrollbar {
      height: 4px;
    }
    .flow-header-bar::-webkit-scrollbar-track {
      background: transparent;
    }
    .flow-header-bar::-webkit-scrollbar-thumb {
      background: #cbd5e1;
      border-radius: 4px;
    }
    .flow-header-bar::-webkit-scrollbar-thumb:hover {
      background: #94a3b8;
    }
    .flow-header-brand {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }
    .flow-header-selector {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      background: #f1f5f9;
      padding: 2px 4px;
      border-radius: 10px;
      border: 1px solid #cbd5e1;
      flex-shrink: 0;
    }
    .flow-header-buttons {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-shrink: 0;
    }

    @media (max-width: 1024px) {
      .flow-builder-container {
        flex-direction: column !important;
        height: auto !important;
        min-height: calc(100vh - 120px) !important;
        padding: 0.5rem !important;
        gap: 0.75rem !important;
      }
      .flow-canvas-wrapper {
        height: 400px !important;
        min-height: 400px !important;
        flex-grow: 0 !important;
      }
      .flow-config-panel {
        width: 100% !important;
        height: auto !important;
        min-height: 400px !important;
      }
      .flow-header-bar {
        flex-direction: column !important;
        align-items: stretch !important;
        padding: 0.75rem 1rem !important;
        gap: 0.75rem !important;
      }
      .flow-header-selector {
        flex-wrap: wrap !important;
        justify-content: space-between !important;
        padding: 4px 8px !important;
      }
      .flow-header-buttons {
        flex-wrap: wrap !important;
        gap: 0.75rem !important;
        justify-content: flex-start !important;
      }
    }

    .flow-header-title-full {
      display: inline-block;
    }
    .flow-header-title-short {
      display: none;
    }
    
    @media (max-width: 1400px) {
      .flow-header-bar {
        padding: 0.6rem 1rem !important;
        gap: 0.75rem !important;
      }
      .flow-header-title-full {
        display: none !important;
      }
      .flow-header-title-short {
        display: inline-block !important;
      }
    }
    @media (max-width: 1200px) {
      .flow-header-title-short {
        display: none !important;
      }
    }
  `;

  return (
    <>
      <style>{customStyles}</style>
      <div className="flow-builder-container">
        
        {/* 1. Sleek Single-Row Top Header Bar & Workspace Canvas Wrapper */}
        <div className="flow-canvas-wrapper">
          
          {/* Top metadata header bar inside the canvas panel container */}
          <div className="flow-header-bar">
            {/* Left section: Brand logo, page title */}
            <div className="flow-header-brand">
              <IconRobot />
              <span className="flow-header-title-full" style={{ fontSize: '0.95rem', fontWeight: '800', letterSpacing: '-0.02em', color: '#0f172a', whiteSpace: 'nowrap' }}>
                Visual Auto-Bot Flow Builder
              </span>
              <span className="flow-header-title-short" style={{ fontSize: '0.95rem', fontWeight: '800', letterSpacing: '-0.02em', color: '#0f172a', whiteSpace: 'nowrap' }}>
                Flow Builder
              </span>
            </div>

            {/* Center section: Flow select selector and title rename widget */}
            <div className="flow-header-selector">
              <select 
                value={currentFlow?.id === null ? 'new-draft' : (currentFlow?.id || 'new')}
                onChange={async (e) => {
                  const selectedId = e.target.value;
                  if (selectedId === 'new-draft') return;
                  
                  if (hasUnsavedChanges) {
                    if (autoSaveEnabled) {
                      setStatusMessage('Saving current flow changes before switching... 🔄');
                      await saveFlowConfig();
                    } else {
                      const confirmed = await showConfirm(
                        "Discard Unsaved Changes",
                        "You have unsaved changes. Are you sure you want to switch workflows?",
                        true
                      );
                      if (!confirmed) return;
                    }
                  }

                  if (selectedId === 'new') {
                    handleCreateNewFlow();
                    return;
                  }
                  
                  const flowId = parseInt(selectedId);
                  const flowObj = flowsList.find(f => f.id === flowId);
                  if (flowObj) {
                    setCurrentFlow(flowObj);
                    setNodes(flowObj.flow_data?.nodes || []);
                    setEdges(flowObj.flow_data?.edges || []);
                    comparisonRef.current = getCleanComparisonString(flowObj.flow_data?.nodes || [], flowObj.flow_data?.edges || []);
                    setHasUnsavedChanges(false);
                    setPast([]);
                    setFuture([]);
                    setSelectedNode(null);
                    setLoadCounter(prev => prev + 1);
                    setScriptText(generateScriptFromFlow(flowObj.flow_data?.nodes || [], flowObj.flow_data?.edges || []));
                  }
                }}
                className="custom-select"
                style={{
                  border: 'none',
                  background: 'transparent',
                  fontWeight: '700',
                  fontSize: '0.78rem',
                  color: '#1e293b',
                  padding: '0.35rem 1.5rem 0.35rem 0.6rem',
                  cursor: 'pointer',
                  outline: 'none',
                  marginRight: '-10px',
                  backgroundImage: "url(\"data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E\")",
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 0.35rem center',
                  backgroundSize: '0.8rem',
                  appearance: 'none',
                  WebkitAppearance: 'none'
                }}
                title="Select workflow to load"
              >
                {currentFlow?.id === null && (
                  <option value="new-draft">{currentFlow.name} * (Draft)</option>
                )}
                {flowsList.map(f => {
                  const displayName = (currentFlow && f.id === currentFlow.id) ? currentFlow.name : f.name;
                  return (
                    <option key={f.id} value={f.id}>
                      {displayName} {f.template_name ? `(${f.template_name})` : '(Global)'} {f.is_active ? '🟢 Active' : '⚪ Draft'}
                    </option>
                  );
                })}
                <option value="new" style={{ color: '#4f46e5', fontWeight: '600' }}>+ Create New...</option>
              </select>

              <div style={{ width: '1px', height: '16px', backgroundColor: '#cbd5e1' }} />

              <input 
                type="text" 
                value={currentFlow?.name || ''} 
                onChange={(e) => {
                  const newName = e.target.value;
                  setCurrentFlow(prev => ({ ...prev, name: newName }));
                  setHasUnsavedChanges(true);
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  fontSize: '0.78rem',
                  fontWeight: '600',
                  padding: '0.35rem 0.5rem',
                  color: '#0f172a',
                  outline: 'none',
                  width: '140px'
                }}
                placeholder="Workflow Name"
                title="Edit workflow name"
              />

              <div style={{ width: '1px', height: '16px', backgroundColor: '#cbd5e1' }} />

              <button 
                className="premium-btn premium-btn-danger" 
                onClick={handleDeleteFlow}
                style={{ 
                  border: 'none', 
                  background: 'transparent', 
                  padding: '0.35rem 0.5rem', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  color: '#df1c1c',
                  cursor: 'pointer'
                }}
                title="Delete current workflow"
              >
                <IconTrash />
              </button>
            </div>

            {/* Right section: Auto-save status, toggle, publish active, save config */}
            <div className="flow-header-buttons">
              {/* Auto-Save Status Banner */}
              {statusMessage ? (
                <span style={{
                  fontSize: '0.72rem',
                  color: statusMessage.includes('✅') || statusMessage.includes('saved') ? '#059669' : '#475569',
                  background: statusMessage.includes('✅') || statusMessage.includes('saved') ? '#ecfdf5' : '#f1f5f9',
                  border: statusMessage.includes('✅') || statusMessage.includes('saved') ? '1px solid #a7f3d0' : '1px solid #e2e8f0',
                  padding: '0.25rem 0.6rem',
                  borderRadius: '12px',
                  fontWeight: '500',
                  animation: 'fadeIn 0.15s ease-in-out',
                  whiteSpace: 'nowrap'
                }}>
                  {statusMessage}
                </span>
              ) : (
                autoSaveEnabled && currentFlow && (
                  <span style={{
                    fontSize: '0.72rem',
                    color: '#059669',
                    background: '#ecfdf5',
                    border: '1px solid #a7f3d0',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '12px',
                    fontWeight: '500',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    whiteSpace: 'nowrap'
                  }}>
                    <span className="pulse-dot" style={{ width: '6px', height: '6px', backgroundColor: '#10b981', borderRadius: '50%', display: 'inline-block' }}></span>
                    Auto-Save Synced
                  </span>
                )
              )}

              {/* iOS Toggle Switch */}
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', userSelect: 'none' }}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <input 
                    type="checkbox" 
                    checked={autoSaveEnabled} 
                    onChange={(e) => setAutoSaveEnabled(e.target.checked)} 
                    style={{ display: 'none' }}
                  />
                  <div style={{
                    width: '34px',
                    height: '18px',
                    backgroundColor: autoSaveEnabled ? '#10b981' : '#cbd5e1',
                    borderRadius: '999px',
                    transition: 'background-color 0.2s',
                    position: 'relative'
                  }}>
                    <div style={{
                      width: '12px',
                      height: '12px',
                      backgroundColor: '#ffffff',
                      borderRadius: '50%',
                      position: 'absolute',
                      top: '3px',
                      left: autoSaveEnabled ? '19px' : '3px',
                      transition: 'left 0.2s',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.15)'
                    }} />
                  </div>
                </div>
                <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-secondary)' }}>
                  Auto-Save
                </span>
              </label>

              {/* Save Config Button */}
              {!autoSaveEnabled && (
                <button 
                  className={`premium-btn ${hasUnsavedChanges ? 'premium-btn-primary' : ''}`}
                  onClick={() => saveFlowConfig()} 
                  disabled={saving}
                  style={{
                    height: '32px',
                    padding: '0.3rem 0.75rem',
                    fontSize: '0.78rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem'
                  }}
                >
                  <IconSave />
                  <span>{saving ? 'Saving...' : 'Save Draft'}</span>
                </button>
              )}


            </div>
          </div>

          {/* Main Visual Canvas Area */}
          <div style={{ flexGrow: 1, position: 'relative', width: '100%', height: '100%' }}>
            
            {/* Floating History Controller (Top-Left of Canvas) */}
            <div className="canvas-history">
              <button 
                className="premium-btn" 
                onClick={undo} 
                disabled={past.length === 0} 
                title="Undo last change"
                style={{ border: 'none', background: 'transparent', padding: '0.35rem 0.5rem', borderRadius: '6px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
              >
                <IconUndo />
                <span>Undo</span>
              </button>
              <button 
                className="premium-btn" 
                onClick={redo} 
                disabled={future.length === 0} 
                title="Redo change"
                style={{ border: 'none', background: 'transparent', padding: '0.35rem 0.5rem', borderRadius: '6px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
              >
                <IconRedo />
                <span>Redo</span>
              </button>
            </div>

            {/* Floating Horizontal Tool Bar (Top-Center of Canvas) */}
            <div className="canvas-toolbar">
              <button 
                className="premium-btn" 
                onClick={addTriggerNode}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: '#4f46e5',
                  fontWeight: '600',
                  padding: '0.35rem 0.65rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem'
                }}
              >
                <IconTrigger />
                <span>+ Trigger</span>
              </button>
              <button 
                className="premium-btn" 
                onClick={addMessageNode}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: '#059669',
                  fontWeight: '600',
                  padding: '0.35rem 0.65rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem'
                }}
              >
                <IconMessage />
                <span>+ Reply</span>
              </button>
              <div className="toolbar-divider"></div>
              <button 
                className="premium-btn" 
                onClick={autoLayout} 
                title="Clean up and align nodes vertically"
                style={{ border: 'none', background: 'transparent', padding: '0.35rem 0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
              >
                <IconLayout />
                <span>Auto-Layout</span>
              </button>
              <button 
                className="premium-btn" 
                onClick={centerView} 
                title="Center and fit flow to view"
                style={{ border: 'none', background: 'transparent', padding: '0.35rem 0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
              >
                <IconCenter />
                <span>Center Flow</span>
              </button>
              <button 
                className="premium-btn" 
                onClick={clearCanvas} 
                title="Reset canvas"
                style={{ border: 'none', background: 'transparent', color: 'var(--color-coral)', padding: '0.35rem 0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
              >
                <IconTrash />
                <span>Clear All</span>
              </button>
            </div>

            {loading || !isReady ? (
              <div style={{ display: 'flex', height: '100%', width: '100%', alignItems: 'center', justifyContent: 'center' }}>
                <div className="spinner"></div>
              </div>
            ) : (
              <div style={{ width: '100%', height: '100%' }}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={onNodeClick}
                  onNodeDragStart={onNodeDragStart}
                  onNodeDragStop={onNodeDragStop}
                  nodeTypes={nodeTypes}
                  proOptions={{ hideAttribution: true }}
                  className="premium-node-builder"
                  onInit={setReactFlowInstance}
                  fitView
                >
                  <Background color="#cbd5e1" gap={16} size={1} />
                  <Controls />
                </ReactFlow>
              </div>
            )}
          </div>
        </div>

        {/* 2. Right Configurator Sidebar */}
        <div className="glass-panel flow-config-panel">
          
          {/* Tab Header Selector */}
          <div style={{ display: 'flex', borderBottom: '1px solid #cbd5e1', background: '#f8fafc' }}>
            <button
              onClick={() => setActiveSidebarTab('config')}
              style={{
                flex: 1,
                padding: '0.75rem 0.5rem',
                border: 'none',
                background: activeSidebarTab === 'config' ? '#ffffff' : 'transparent',
                borderBottom: activeSidebarTab === 'config' ? '2px solid #4f46e5' : 'none',
                color: activeSidebarTab === 'config' ? '#4f46e5' : '#475569',
                fontWeight: '600',
                fontSize: '0.78rem',
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              ⚙️ Node Config
            </button>
            <button
              onClick={() => {
                setActiveSidebarTab('script');
                setScriptText(generateScriptFromFlow(nodes, edges));
              }}
              style={{
                flex: 1,
                padding: '0.75rem 0.5rem',
                border: 'none',
                background: activeSidebarTab === 'script' ? '#ffffff' : 'transparent',
                borderBottom: activeSidebarTab === 'script' ? '2px solid #4f46e5' : 'none',
                color: activeSidebarTab === 'script' ? '#4f46e5' : '#475569',
                fontWeight: '600',
                fontSize: '0.78rem',
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              📝 Script Editor
            </button>
            <button
              onClick={() => setActiveSidebarTab('mappings')}
              style={{
                flex: 1,
                padding: '0.75rem 0.5rem',
                border: 'none',
                background: activeSidebarTab === 'mappings' ? '#ffffff' : 'transparent',
                borderBottom: activeSidebarTab === 'mappings' ? '2px solid #4f46e5' : 'none',
                color: activeSidebarTab === 'mappings' ? '#4f46e5' : '#475569',
                fontWeight: '600',
                fontSize: '0.78rem',
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              🗺️ Mappings
            </button>
          </div>

          <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.85rem', flexGrow: 1, overflowY: 'auto' }}>
            {activeSidebarTab === 'config' && (
              selectedNode ? (
                <>
                  <div style={{ fontSize: '0.75rem', padding: '0.5rem 0.75rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ color: 'var(--text-secondary)' }}>ID:</span> <strong style={{ fontFamily: 'monospace', color: '#334155' }}>{selectedNode.id}</strong>
                    </div>
                    <span style={{
                      fontSize: '0.65rem',
                      background: selectedNode.type === 'trigger' ? '#e0e7ff' : '#d1fae5',
                      color: selectedNode.type === 'trigger' ? '#4f46e5' : '#065f46',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      fontWeight: '600',
                      textTransform: 'uppercase'
                    }}>
                      {selectedNode.type}
                    </span>
                  </div>

                  {selectedNode.type === 'trigger' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Incoming Keyword
                      </label>
                      <input
                        type="text"
                        className="premium-input"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        placeholder="e.g. interested (or default)"
                      />
                      <p style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.1rem', lineHeight: '1.3' }}>
                        Incoming message word that triggers this response flow. Use "default" for a fallback handler.
                      </p>
                    </div>
                  )}

                  {selectedNode.type === 'message' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                        <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Bot Reply Text
                        </label>
                        <textarea
                          className="premium-input premium-textarea premium-input-emerald"
                          value={messageText}
                          onChange={(e) => setMessageText(e.target.value)}
                          placeholder="Type the WhatsApp response..."
                        />
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                        <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Attachment URL (Image/PDF)
                        </label>
                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                          <input
                            type="text"
                            className="premium-input premium-input-emerald"
                            value={mediaUrl}
                            onChange={(e) => setMediaUrl(e.target.value)}
                            placeholder="https://example.com/document.pdf or image.jpg"
                            style={{ padding: '0.45rem 0.6rem', fontSize: '0.8rem', flexGrow: 1 }}
                          />
                          <label 
                            className="premium-btn premium-btn-secondary" 
                            style={{ 
                              padding: '0.45rem 0.65rem', 
                              fontSize: '0.75rem', 
                              cursor: 'pointer', 
                              margin: 0, 
                              display: 'flex', 
                              alignItems: 'center', 
                              gap: '0.2rem',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {uploading ? '⌛ Uploading...' : '📁 Upload File'}
                            <input
                              type="file"
                              style={{ display: 'none' }}
                              onChange={handleAttachmentUpload}
                              disabled={uploading}
                              accept=".jpg,.jpeg,.png,.gif,.pdf,.docx,.xlsx"
                            />
                          </label>
                        </div>
                        <p style={{ fontSize: '0.62rem', color: 'var(--text-secondary)', marginTop: '0.1rem', lineHeight: '1.2' }}>
                          Upload an attachment (brochure, image, PDF) directly, or paste a link.
                        </p>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Quick Reply Buttons (Max 3)
                        </label>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                          {buttons.map((btn, idx) => (
                            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                              <span style={{ fontSize: '0.75rem', color: '#94a3b8', width: '12px' }}>{idx + 1}</span>
                              <input
                                type="text"
                                className="premium-input premium-input-emerald"
                                value={btn}
                                onChange={(e) => handleButtonChange(idx, e.target.value)}
                                placeholder={`Button ${idx + 1} Label`}
                                style={{ padding: '0.35rem 0.5rem', fontSize: '0.8rem', flexGrow: 1 }}
                                maxLength={20}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const newBtns = buttons.filter((_, i) => i !== idx);
                                  setButtons(newBtns);
                                }}
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  color: '#ef4444',
                                  cursor: 'pointer',
                                  fontSize: '0.9rem',
                                  padding: '0.2rem',
                                  display: 'flex',
                                  alignItems: 'center'
                                }}
                                title="Remove button"
                              >
                                🗑️
                              </button>
                            </div>
                          ))}
                          {buttons.length < 3 && (
                            <button
                              type="button"
                              className="premium-btn premium-btn-secondary"
                              onClick={() => setButtons([...buttons, ''])}
                              style={{
                                marginTop: '0.2rem',
                                padding: '0.35rem 0.5rem',
                                fontSize: '0.72rem',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '0.2rem',
                                width: 'fit-content'
                              }}
                            >
                              ➕ Add Button Option
                            </button>
                          )}
                        </div>
                        <p style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.1rem', lineHeight: '1.3' }}>
                          Admins can configure up to 3 quick reply buttons. Students click these to continue traversal.
                        </p>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.75rem', borderTop: '1px solid #e2e8f0', paddingTop: '0.85rem' }}>
                    <button className="premium-btn premium-btn-primary" style={{ flexGrow: 1 }} onClick={updateSelectedNode}>
                      Update Node
                    </button>
                    <button className="premium-btn" style={{ padding: '0.4rem 0.6rem' }} onClick={cloneSelectedNode} title="Duplicate Node">
                      📋 Clone
                    </button>
                    <button 
                      className="premium-btn premium-btn-danger" 
                      onClick={deleteSelectedNode}
                      style={{ padding: '0.4rem 0.6rem' }}
                      title="Delete Node"
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </>
              ) : (
                <div style={{
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '0.8rem',
                  padding: '4rem 1rem',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}>
                  <div style={{ fontSize: '1.75rem', opacity: '0.7' }}>⚙️</div>
                  <div>No node selected. Click any node on the canvas to configure settings.</div>
                </div>
              )
            )}

            {activeSidebarTab === 'script' && (
              /* Script Editor Tab Content */
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%' }}>
                <div style={{ fontSize: '0.68rem', color: '#64748b', lineHeight: '1.4', background: '#f8fafc', padding: '0.5rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}>
                  <strong style={{ color: '#475569' }}>Format Instructions:</strong><br />
                  • Trigger keyword:<br />
                  <code style={{ background: '#e2e8f0', padding: '1px 3px', borderRadius: '3px' }}>Trigger: interested -&gt; [welcome]</code><br />
                  • Bot response message &amp; replies:<br />
                  <code style={{ background: '#e2e8f0', padding: '1px 3px', borderRadius: '3px' }}>[welcome]</code><br />
                  <code style={{ background: '#e2e8f0', padding: '1px 3px', borderRadius: '3px' }}>Bot: Hi there! Choose yes or no</code><br />
                  <code style={{ background: '#e2e8f0', padding: '1px 3px', borderRadius: '3px' }}>- Yes -&gt; [yes_node]</code><br />
                  <code style={{ background: '#e2e8f0', padding: '1px 3px', borderRadius: '3px' }}>- No -&gt; [no_node]</code>
                </div>

                <textarea
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  style={{
                    width: '100%',
                    height: '350px',
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    padding: '0.5rem',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    resize: 'vertical',
                    backgroundColor: '#0f172a',
                    color: '#38bdf8',
                    lineHeight: '1.4',
                    boxSizing: 'border-box'
                  }}
                  placeholder="// Write your flow script here..."
                />

                <button
                  className="premium-btn premium-btn-primary"
                  onClick={async () => {
                    pushToHistory(nodes, edges);
                    const { nodes: newNodes, edges: newEdges } = parseScriptToFlow(scriptText);
                    if (newNodes.length === 0) {
                      await showAlert("Empty Script", "We could not find any valid nodes or triggers in your script. Please check the format.");
                      return;
                    }
                    
                    const positionedNodes = computeAutoLayout(newNodes);
                    setNodes(positionedNodes);
                    setEdges(newEdges);
                    setSelectedNode(null);
                    setHasUnsavedChanges(true);
                    setLoadCounter(prev => prev + 1);
                    setStatusMessage("Flow synchronized from script! ⚡");
                    setTimeout(() => setStatusMessage(""), 3000);
                  }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
                >
                  <span>Sync to Canvas ⚡</span>
                </button>
              </div>
            )}

            {activeSidebarTab === 'mappings' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                {/* 1. Visual routing guide card explaining the priority path */}
                <div style={{
                  fontSize: '0.72rem',
                  color: '#1e293b',
                  background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
                  border: '1px solid #bfdbfe',
                  padding: '0.85rem',
                  borderRadius: '12px',
                  lineHeight: '1.45'
                }}>
                  <strong style={{ color: '#1e40af', display: 'block', fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                    🗺️ Chatbot Routing Map
                  </strong>
                  <p style={{ marginBottom: '0.75rem', color: '#1e3a8a' }}>
                    When a student replies, the chatbot decides which flow to run using this priority path:
                  </p>
                  
                  {/* Visual Stepper / Flowchart */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'rgba(255, 255, 255, 0.5)', padding: '0.6rem', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.5)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '18px', height: '18px', background: '#3b82f6', color: '#ffffff', borderRadius: '50%', fontSize: '0.65rem', fontWeight: 'bold' }}>1</span>
                      <strong style={{ color: '#1e293b' }}>Template Flow</strong>
                      <span style={{ fontSize: '0.65rem', color: '#64748b' }}>(First)</span>
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#475569', marginLeft: '1.4rem', borderLeft: '2px solid #3b82f6', paddingLeft: '0.5rem', paddingBottom: '0.25rem' }}>
                      Checks if there is an active flow matching the contact's last template (e.g. <code>parent_outreach</code>).
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '18px', height: '18px', background: '#8b5cf6', color: '#ffffff', borderRadius: '50%', fontSize: '0.65rem', fontWeight: 'bold' }}>2</span>
                      <strong style={{ color: '#1e293b' }}>Global Default</strong>
                      <span style={{ fontSize: '0.65rem', color: '#64748b' }}>(Fallback)</span>
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#475569', marginLeft: '1.4rem', borderLeft: '2px solid #8b5cf6', paddingLeft: '0.5rem', paddingBottom: '0.25rem' }}>
                      If no template flow is set, runs the <code>Global Default Flow</code>.
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '18px', height: '18px', background: '#64748b', color: '#ffffff', borderRadius: '50%', fontSize: '0.65rem', fontWeight: 'bold' }}>3</span>
                      <strong style={{ color: '#1e293b' }}>Keyword Rules</strong>
                      <span style={{ fontSize: '0.65rem', color: '#64748b' }}>(Final)</span>
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#475569', marginLeft: '1.4rem', paddingLeft: '0.5rem' }}>
                      If neither matches, falls back to legacy keyword Auto-Reply Rules.
                    </div>
                  </div>
                </div>

                {/* 2. List of template/global entries */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem' }}>
                  
                  {/* Row for Global Default Flow */}
                  <div style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '0.75rem',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <span style={{ fontWeight: '700', fontSize: '0.8rem', color: '#0f172a' }}>Global Default Flow</span>
                      {(() => {
                        const activeGlobal = flowsList.find(f => f.is_active && (!f.template_name || f.template_name === ""));
                        return activeGlobal ? (
                          <span style={{ fontSize: '0.68rem', color: '#059669', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '1px 6px', borderRadius: '4px', fontWeight: '600' }}>
                            🟢 Active
                          </span>
                        ) : (
                          <span style={{ fontSize: '0.68rem', color: '#64748b', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '1px 6px', borderRadius: '4px', fontWeight: '500' }}>
                            ⚪ Inactive
                          </span>
                        );
                      })()}
                    </div>
                    
                    {/* Select flow for Global */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <span style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: '600' }}>Assigned Flow:</span>
                        <select
                          value={(() => {
                            const activeGlobal = flowsList.find(f => f.is_active && (!f.template_name || f.template_name === ""));
                            return activeGlobal ? activeGlobal.id : '';
                          })()}
                          onChange={async (e) => {
                            const val = e.target.value;
                            if (!val) {
                              // Deactivate active global if there is one
                              const activeGlobal = flowsList.find(f => f.is_active && (!f.template_name || f.template_name === ""));
                              if (activeGlobal) {
                                await handleToggleFlowActive(activeGlobal, false);
                              }
                            } else {
                              const flowObj = flowsList.find(f => f.id === parseInt(val));
                              if (flowObj) {
                                await handleAssignFlowToTemplate(flowObj, null, true);
                              }
                            }
                          }}
                          className="premium-input"
                          style={{ width: '100%', padding: '0.35rem 0.5rem', fontSize: '0.75rem', height: '32px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#ffffff', outline: 'none' }}
                        >
                          <option value="">-- No Active Flow (None) --</option>
                          {flowsList.map(f => {
                            const displayName = (currentFlow && f.id === currentFlow.id) ? currentFlow.name : f.name;
                            return (
                              <option key={f.id} value={f.id}>{displayName}</option>
                            );
                          })}
                        </select>
                      </div>
                      {(() => {
                        const activeGlobal = flowsList.find(f => f.is_active && (!f.template_name || f.template_name === ""));
                        return activeGlobal ? (
                          <div style={{ display: 'flex', gap: '0.4rem' }}>
                            <button
                              className="premium-btn"
                              style={{ flex: 1, padding: '0.35rem', fontSize: '0.7rem', height: '28px', border: '1px solid #fca5a5', color: '#dc2626', background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.2rem' }}
                              onClick={() => handleToggleFlowActive(activeGlobal, false)}
                            >
                              Deactivate
                            </button>
                            <button
                              className="premium-btn"
                              style={{ flex: 1, padding: '0.35rem', fontSize: '0.7rem', height: '28px', border: '1px solid #bfdbfe', color: '#2563eb', background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.2rem' }}
                              onClick={() => handleLoadFlowIntoCanvas(activeGlobal)}
                            >
                              Edit Canvas ✏️
                            </button>
                          </div>
                        ) : null;
                      })()}
                    </div>
                  </div>

                  {/* Divider */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0.25rem 0' }}>
                    <div style={{ height: '1px', backgroundColor: '#e2e8f0', flexGrow: 1 }} />
                    <span style={{ fontSize: '0.65rem', fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase' }}>Templates</span>
                    <div style={{ height: '1px', backgroundColor: '#e2e8f0', flexGrow: 1 }} />
                  </div>

                  {/* List of Templates from templatesList */}
                  {templatesList.length === 0 ? (
                    <div style={{ fontSize: '0.7rem', color: '#64748b', fontStyle: 'italic', textAlign: 'center', padding: '0.5rem' }}>
                      No templates synced from Meta.
                    </div>
                  ) : (
                    templatesList.map(t => {
                      const activeFlow = flowsList.find(f => f.is_active && f.template_name?.toLowerCase() === t.template_name?.toLowerCase());
                      return (
                        <div key={t.id} style={{
                          background: '#ffffff',
                          border: '1px solid #e2e8f0',
                          borderRadius: '8px',
                          padding: '0.75rem',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <span style={{ fontWeight: '700', fontSize: '0.8rem', color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }} title={t.template_name}>
                              {t.template_name}
                            </span>
                            {activeFlow ? (
                              <span style={{ fontSize: '0.68rem', color: '#059669', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '1px 6px', borderRadius: '4px', fontWeight: '600' }}>
                                🟢 Active
                              </span>
                            ) : (
                              <span style={{ fontSize: '0.68rem', color: '#64748b', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '1px 6px', borderRadius: '4px', fontWeight: '500' }}>
                                ⚪ Fallback to Global
                              </span>
                            )}
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                              <span style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: '600' }}>Assigned Flow:</span>
                              <select
                                value={activeFlow ? activeFlow.id : ''}
                                onChange={async (e) => {
                                  const val = e.target.value;
                                  if (!val) {
                                    if (activeFlow) {
                                      await handleToggleFlowActive(activeFlow, false);
                                    }
                                  } else {
                                    const flowObj = flowsList.find(f => f.id === parseInt(val));
                                    if (flowObj) {
                                      await handleAssignFlowToTemplate(flowObj, t.template_name, true);
                                    }
                                  }
                                }}
                                className="premium-input"
                                style={{ width: '100%', padding: '0.35rem 0.5rem', fontSize: '0.75rem', height: '32px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#ffffff', outline: 'none' }}
                              >
                                <option value="">-- Fallback to Global (None) --</option>
                                {flowsList.map(f => {
                                  const displayName = (currentFlow && f.id === currentFlow.id) ? currentFlow.name : f.name;
                                  return (
                                    <option key={f.id} value={f.id}>{displayName}</option>
                                  );
                                })}
                              </select>
                            </div>
                            {activeFlow && (
                              <div style={{ display: 'flex', gap: '0.4rem' }}>
                                <button
                                  className="premium-btn"
                                  style={{ flex: 1, padding: '0.35rem', fontSize: '0.7rem', height: '28px', border: '1px solid #fca5a5', color: '#dc2626', background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.2rem' }}
                                  onClick={() => handleToggleFlowActive(activeFlow, false)}
                                >
                                  Deactivate
                                </button>
                                <button
                                  className="premium-btn"
                                  style={{ flex: 1, padding: '0.35rem', fontSize: '0.7rem', height: '28px', border: '1px solid #bfdbfe', color: '#2563eb', background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.2rem' }}
                                  onClick={() => handleLoadFlowIntoCanvas(activeFlow)}
                                >
                                  Edit Canvas ✏️
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Custom Modal Overlay */}
      {modalConfig.isOpen && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.4)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
          animation: 'fadeIn 0.2s ease-out'
        }}>
          <div style={{
            background: '#ffffff',
            borderRadius: '12px',
            border: '1px solid #cbd5e1',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.05)',
            padding: '1.5rem',
            maxWidth: '400px',
            width: 'calc(100% - 2rem)',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            animation: 'slideDown 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
          }}>
            {/* Modal Title */}
            <h4 style={{
              margin: 0,
              fontSize: '1.05rem',
              fontWeight: '700',
              color: '#0f172a',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              {modalConfig.type === 'alert' && <span style={{ color: '#d97706' }}>⚠️</span>}
              {modalConfig.type === 'confirm' && (modalConfig.isDestructive ? <span style={{ color: '#df1c1c' }}>🚨</span> : <span style={{ color: '#4f46e5' }}>❓</span>)}
              {modalConfig.type === 'prompt' && <span style={{ color: '#4f46e5' }}>✏️</span>}
              {modalConfig.title}
            </h4>

            {/* Modal Message */}
            <p style={{
              margin: 0,
              fontSize: '0.85rem',
              color: '#475569',
              lineHeight: '1.5'
            }}>
              {modalConfig.message}
            </p>

            {/* Prompt Input */}
            {modalConfig.type === 'prompt' && (
              <input
                type="text"
                className="premium-input"
                value={modalConfig.inputValue}
                onChange={(e) => {
                  const val = e.target.value;
                  setModalConfig(prev => ({ ...prev, inputValue: val }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    modalConfig.onConfirm(modalConfig.inputValue);
                  }
                }}
                autoFocus
                style={{
                  width: '100%',
                  boxSizing: 'border-box'
                }}
              />
            )}

            {/* Action Buttons */}
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.5rem',
              marginTop: '0.25rem'
            }}>
              {modalConfig.type !== 'alert' && (
                <button
                  className="premium-btn"
                  onClick={modalConfig.onCancel}
                  style={{ padding: '0.4rem 0.85rem' }}
                >
                  Cancel
                </button>
              )}
              <button
                className={`premium-btn ${modalConfig.isDestructive ? 'premium-btn-danger' : 'premium-btn-primary'}`}
                onClick={() => modalConfig.onConfirm(modalConfig.type === 'prompt' ? modalConfig.inputValue : true)}
                style={{
                  padding: '0.4rem 0.85rem',
                  background: modalConfig.isDestructive 
                    ? '#df1c1c' 
                    : 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)',
                  color: '#ffffff',
                  border: 'none'
                }}
              >
                {modalConfig.type === 'prompt' ? 'OK' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
