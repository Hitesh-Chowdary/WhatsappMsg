import React, { useState, useEffect, useCallback, useMemo } from 'react';
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

// Custom Trigger Node
const TriggerNode = ({ data, isConnectable }) => {
  return (
    <div style={{
      padding: '0.75rem 1rem',
      borderRadius: 'var(--radius-md)',
      background: 'rgba(255, 255, 255, 0.95)',
      border: '2px solid var(--color-indigo)',
      boxShadow: '0 4px 12px rgba(99, 102, 241, 0.15)',
      fontFamily: 'inherit',
      fontSize: '0.8rem',
      minWidth: '160px',
      textAlign: 'left'
    }}>
      <div style={{
        fontWeight: 'bold',
        color: 'var(--color-indigo)',
        marginBottom: '0.25rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.25rem'
      }}>
        ⚡ Trigger Keyword
      </div>
      <div style={{ color: 'var(--color-slate-700)' }}>
        {data.keyword ? `"${data.keyword}"` : 'Fallback (default)'}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: 'var(--color-indigo)', width: '8px', height: '8px' }}
        isConnectable={isConnectable}
      />
    </div>
  );
};

// Custom Message Node
const MessageNode = ({ data, isConnectable }) => {
  return (
    <div style={{
      padding: '0.75rem 1rem',
      borderRadius: 'var(--radius-md)',
      background: 'rgba(255, 255, 255, 0.95)',
      border: '2px solid var(--color-emerald)',
      boxShadow: '0 4px 12px rgba(16, 185, 129, 0.15)',
      fontFamily: 'inherit',
      fontSize: '0.8rem',
      minWidth: '200px',
      textAlign: 'left'
    }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: 'var(--color-emerald)', width: '8px', height: '8px' }}
        isConnectable={isConnectable}
      />
      <div style={{
        fontWeight: 'bold',
        color: 'var(--color-emerald)',
        marginBottom: '0.25rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.25rem'
      }}>
        💬 Message Reply
      </div>
      <div style={{
        color: 'var(--color-slate-700)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '180px',
        marginBottom: '0.4rem'
      }}>
        {data.text || '(empty message)'}
      </div>
      {data.buttons && data.buttons.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.25rem' }}>
          {data.buttons.map((btn, i) => (
            <span key={i} style={{
              fontSize: '0.65rem',
              background: '#f1f5f9',
              border: '1px solid #cbd5e1',
              borderRadius: '3px',
              padding: '0.1rem 0.3rem',
              color: '#475569'
            }}>
              🔘 {btn}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default function FlowBuilder({ authFetch, API_BASE }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  
  // Node fields
  const [keyword, setKeyword] = useState('');
  const [messageText, setMessageText] = useState('');
  const [buttons, setButtons] = useState(['', '', '']);
  
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  // Define custom node types
  const nodeTypes = useMemo(() => ({
    trigger: TriggerNode,
    message: MessageNode
  }), []);

  // Fetch saved BotFlow from backend
  const loadFlow = useCallback(async () => {
    setLoading(true);
    
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

    try {
      const res = await authFetch(`${API_BASE}/api/v1/bot/flows`);
      if (res && res.ok) {
        const flows = await res.json();
        if (flows && flows.length > 0) {
          // Load the first (most recent) flow configuration
          const flow = flows[0];
          const data = flow.flow_data || { nodes: [], edges: [] };
          setNodes(data.nodes || []);
          setEdges(data.edges || []);
          return;
        }
      }
      
      // Initialize default node setup if empty
      setNodes(initialNodes);
      setEdges(initialEdges);
    } catch (e) {
      console.error("Failed to load bot flow:", e);
      // Initialize default node setup as fallback in case of errors
      setNodes(initialNodes);
      setEdges(initialEdges);
    } finally {
      setLoading(false);
    }
  }, [authFetch, API_BASE, setNodes, setEdges]);

  useEffect(() => {
    loadFlow();
  }, [loadFlow]);

  // Connect edge handler
  const onConnect = useCallback((connection) => {
    setEdges((eds) => addEdge(connection, eds));
  }, [setEdges]);

  // Node click handler
  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node);
    if (node.type === 'trigger') {
      setKeyword(node.data.keyword || '');
    } else if (node.type === 'message') {
      setMessageText(node.data.text || '');
      const btns = node.data.buttons || [];
      setButtons([btns[0] || '', btns[1] || '', btns[2] || '']);
    }
  }, []);

  // Node editing state updates
  const updateSelectedNode = () => {
    if (!selectedNode) return;
    
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
              data: { ...node.data, text: messageText, buttons: activeBtns }
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
    setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id));
    setSelectedNode(null);
  };

  // Save layout to backend
  const saveFlowConfig = async () => {
    setSaving(true);
    setStatusMessage('');
    try {
      const payload = {
        name: 'Default Flow',
        flow_data: { nodes, edges },
        is_active: true
      };
      
      const res = await authFetch(`${API_BASE}/api/v1/bot/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (res && res.ok) {
        const data = await res.json();
        if (data.status === 'success') {
          setStatusMessage('Bot workflow saved and active successfully! ✅');
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

  const handleButtonChange = (index, val) => {
    const newBtns = [...buttons];
    newBtns[index] = val;
    setButtons(newBtns);
  };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 120px)', width: '100%', gap: '1rem', padding: '1rem' }}>
      
      {/* 1. Left Canvas Panel */}
      <div className="glass-panel" style={{ flexGrow: 1, position: 'relative', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{
          padding: '1rem',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(255,255,255,0.4)',
          zIndex: 10
        }}>
          <div>
            <h3 style={{ fontWeight: 700, fontSize: '1.15rem' }}>Visual Auto-Bot Flow Builder</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Drag and connect trigger keywords to reply messages.</p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-secondary btn-sm" onClick={addTriggerNode}>+ Trigger Node</button>
            <button className="btn btn-secondary btn-sm" onClick={addMessageNode}>+ Message Node</button>
            <button className="btn btn-primary btn-sm" onClick={saveFlowConfig} disabled={saving}>
              {saving ? 'Saving...' : 'Save & Activate Flow'}
            </button>
          </div>
        </div>
        
        {loading ? (
          <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}>
            <div className="spinner"></div>
          </div>
        ) : (
          <div style={{ flexGrow: 1, height: '100%' }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              nodeTypes={nodeTypes}
              fitView
            >
              <Background color="#cbd5e1" gap={16} size={1} />
              <Controls />
            </ReactFlow>
          </div>
        )}
      </div>

      {/* 2. Right Configurator Sidebar */}
      <div className="glass-panel" style={{ width: '320px', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.4)' }}>
          <h4 style={{ fontWeight: 700, fontSize: '1rem' }}>Node Settings</h4>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Select a node in the canvas to edit its actions.</p>
        </div>

        <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', flexGrow: 1, overflowY: 'auto' }}>
          {selectedNode ? (
            <>
              <div style={{ fontSize: '0.75rem', padding: '0.5rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 'var(--radius-sm)' }}>
                <strong>Node ID:</strong> {selectedNode.id} <br />
                <strong>Type:</strong> {selectedNode.type.toUpperCase()}
              </div>

              {selectedNode.type === 'trigger' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Incoming Keyword:</label>
                  <input
                    type="text"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.5rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.85rem'
                    }}
                    placeholder="e.g. interested (or default)"
                  />
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.125rem' }}>
                    Type a keyword that triggers this response. Use "default" for a fallback handler.
                  </p>
                </div>
              )}

              {selectedNode.type === 'message' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Bot Reply Text:</label>
                    <textarea
                      value={messageText}
                      onChange={(e) => setMessageText(e.target.value)}
                      style={{
                        width: '100%',
                        height: '100px',
                        padding: '0.5rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '0.85rem',
                        resize: 'none',
                        fontFamily: 'inherit'
                      }}
                      placeholder="Type the WhatsApp response..."
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Quick Reply Buttons (Max 3):</label>
                    {buttons.map((btn, idx) => (
                      <input
                        key={idx}
                        type="text"
                        value={btn}
                        onChange={(e) => handleButtonChange(idx, e.target.value)}
                        style={{
                          width: '100%',
                          padding: '0.4rem',
                          border: '1px solid var(--border-color)',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '0.8rem'
                        }}
                        placeholder={`Button ${idx + 1} Label`}
                      />
                    ))}
                    <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      Students will be able to click these buttons to trigger other keyword actions.
                    </p>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button className="btn btn-primary btn-sm" style={{ flexGrow: 1 }} onClick={updateSelectedNode}>
                  Update Node
                </button>
                <button 
                  className="btn btn-danger btn-sm" 
                  onClick={deleteSelectedNode}
                  style={{ padding: '0.5rem' }}
                  title="Delete Node"
                >
                  🗑️
                </button>
              </div>
            </>
          ) : (
            <div style={{
              textAlign: 'center',
              color: 'var(--text-secondary)',
              fontSize: '0.85rem',
              padding: '2rem 1rem'
            }}>
              No node selected. Click a node on the canvas to configure it.
            </div>
          )}
        </div>

        {statusMessage && (
          <div style={{
            padding: '0.75rem',
            background: 'var(--color-indigo)',
            color: 'white',
            fontSize: '0.75rem',
            textAlign: 'center',
            fontWeight: 500
          }}>
            {statusMessage}
          </div>
        )}
      </div>

    </div>
  );
}
